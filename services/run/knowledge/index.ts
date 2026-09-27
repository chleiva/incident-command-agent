/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Knowledge index loader + hybrid retrieval (spec §9). The pipeline for one query:
 *
 *   (a) BM25 over header + text, in memory (always)
 *   (b) query embedding (Cohere Embed v4 `search_query`, LRU-cached per container) → vector search: Amazon S3 Vectors
 *       `QueryVectors` topK 50 with a collection/jurisdiction metadata filter, or in-memory cosine
 *   → reciprocal rank fusion → collapse hits of the same docId → Cohere Rerank 3.5 over the top 30 → k hits.
 *
 * Graceful degradation: an embedding, vector-store or rerank error or timeout (≈1.5 s / 1.5 s / 2 s) falls back to
 * the previous stage (fused without rerank → BM25 only); it is logged and never fails a run.
 *
 * Backend selection (env, set by CDK on the Run/author Lambdas; see `knowledgeRuntimeConfig`):
 *   KB_VECTOR_STORE   s3vectors | memory | none   (default: the manifest's `embeddings.store`)
 *   KB_VECTOR_BUCKET, KB_VECTOR_INDEX            the S3 Vectors index (s3vectors)
 *   KB_EMBED_MODEL, KB_EMBED_DIMS                 expected query embedder; must match the manifest (else refused)
 *   KB_EMBED_REGION                               Bedrock region for the query embedder (default AWS_REGION)
 *   KB_RERANK on|off, KB_RERANK_MODEL, KB_RERANK_REGION   (default on with s3vectors; eu-central-1)
 *   KB_EMBEDDINGS=none                            BM25 only
 * Local dev: an int8 (MiniLM) index searches in memory; a cohere-built index read from disk uses its `vectors/`
 * files in memory when no S3 Vectors index is configured (Bedrock credentials needed for query embeddings, else BM25).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Bm25Scorer,
  INDEX_FILES,
  SUPPORTED_INDEX_VERSIONS,
  VECTOR_FILES,
  asTyped,
  bm25FromFiles,
  createEmbedder,
  docIdOf,
  indexText,
  parseChunks,
  serialiseIndex,
  vectorsFromBytes,
  type Bm25Stats,
  type ChunkRecord,
  type EmbedInputType,
  type IndexManifest,
  type VectorStoreKind,
} from '@ica/kb';
import type { KnowledgeHit, KnowledgeIndex, KnowledgeQuery } from '@ica/schema';
import {
  RERANK_MODEL,
  RERANK_REGION,
  RerankBudget,
  cohereReranker,
  isThrottle,
  type Reranker,
} from './rerank';
import {
  floatScorer,
  int8Scorer,
  memoryVectorSearch,
  s3VectorSearch,
  type VectorQuery,
  type VectorSearch,
} from './vectors';

export type { Reranker } from './rerank';
export type { VectorSearch, VectorHit, VectorQuery } from './vectors';
export { RerankBudget, cohereReranker } from './rerank';
export { memoryVectorSearch, s3VectorSearch } from './vectors';

export interface QueryEmbedder {
  /** Optional: the dimension this embedder produces (validated against the manifest). */
  dim?: number;
  model?: string;
  embed(
    texts: string[],
    opts?: { inputType?: EmbedInputType; signal?: AbortSignal },
  ): Promise<Float32Array[]>;
}

export interface LoadKnowledgeOptions {
  source: 'fs' | 's3';
  /** Directory (fs) or s3://bucket/prefix (s3). */
  path: string;
  /**
   * 'auto' (default): hybrid when the manifest has embeddings and a vector backend is available, falling back to
   * BM25 on failure. 'none': BM25 only. Env `KB_EMBEDDINGS=none` also forces BM25.
   */
  embeddings?: 'auto' | 'none';
  /** Inject a query embedder (tests; or a pre-warmed one). */
  embedder?: QueryEmbedder;
  /** Inject a vector backend (tests), or `null` to disable dense retrieval. */
  vectorSearch?: VectorSearch | null;
  /** Inject a reranker (tests), or `null` to disable reranking. */
  reranker?: Reranker | null;
  /** Inject the rerank rate budget (tests). Default: `KB_RERANK_RPM` per minute (3), shared per container. */
  rerankBudget?: RerankBudget;
  /** Where the local model files live / are cached (Lambda: a /tmp path or files synced from S3). */
  modelCacheDir?: string;
  /** Environment for backend selection (default process.env). */
  env?: Record<string, string | undefined>;
  /** Skip the per-container cache. */
  noCache?: boolean;
}

export type RetrievalStage = 'bm25' | 'hybrid' | 'hybrid+rerank';

export interface SearchTrace {
  mode: RetrievalStage;
  fallbacks: { stage: 'embed' | 'vector' | 'rerank'; error: string }[];
  /** What happened at the rerank step (selective rerank under the per-minute quota). */
  rerank?: 'applied' | 'cached' | 'skipped_agreement' | 'skipped_budget' | 'failed';
  ms: number;
}

export interface LoadedKnowledgeIndex extends KnowledgeIndex {
  readonly size: number;
  readonly manifest: IndexManifest | null;
  /** 'hybrid' when dense retrieval is configured (and the embedder loaded), otherwise 'bm25'. */
  mode(): 'hybrid' | 'bm25';
  /** What the last search actually did (stages used, fallbacks). */
  lastTrace(): SearchTrace | null;
  getChunk(chunkId: string): ChunkRecord | undefined;
}

type Files = Partial<Record<keyof typeof INDEX_FILES, Uint8Array>>;

/** Raised when the index was built with a different embedding model/dimension than the runtime expects. */
export class KnowledgeIndexMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KnowledgeIndexMismatchError';
  }
}

/** The committed fixture mini-corpus index (tests, CI, local dev without `kb:build`). */
export const FIXTURE_INDEX_DIR = fileURLToPath(new URL('../../../data/fixtures/index/', import.meta.url));
/** Where `npm run kb:build` writes the full index. */
export const DEFAULT_INDEX_DIR = fileURLToPath(new URL('../../../data/index/', import.meta.url));

/**
 * `s3://{KNOWLEDGE_BUCKET}/index`: where `npm run kb:upload` puts `data/index/`. The ApiStack sets `KNOWLEDGE_BUCKET`
 * on the Run and author Lambdas; this is the single place that turns it into an index path.
 */
export function knowledgeS3PathFromEnv(env: Record<string, string | undefined> = process.env): string {
  const bucket = env.KNOWLEDGE_BUCKET?.trim();
  if (!bucket) throw new Error('KNOWLEDGE_BUCKET is not set');
  return `s3://${bucket}/index`;
}

const RRF_K = 60;
/** Candidates taken from each retriever (BM25, vectors) before fusion. */
export const CANDIDATES = 50;
/** Fused, docId-collapsed candidates sent to the reranker. */
export const RERANK_CANDIDATES = 30;
/** Characters of header + text sent to the reranker per candidate. */
const RERANK_DOC_CHARS = 4000;
const QUERY_CACHE_SIZE = 256;
const RERANK_CACHE_SIZE = 256;
let sharedRerankBudget: RerankBudget | undefined;

const cache = new Map<string, Promise<LoadedKnowledgeIndex>>();
const log = (level: 'info' | 'warn' | 'error', msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ level, component: 'knowledge', msg, ...extra }));

export interface KnowledgeRuntimeConfig {
  store: VectorStoreKind;
  bucket?: string;
  index?: string;
  region?: string;
  embedModel?: string;
  embedDims?: number;
  embedRegion?: string;
  rerank: boolean;
  rerankModel: string;
  rerankRegion: string;
  /** Rerank requests per minute this container may spend (0 = unlimited). */
  rerankRpm: number;
  timeouts: { embedMs: number; vectorMs: number; rerankMs: number };
}

const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) : d);

/** Resolve the retrieval backends from env + the index manifest. */
export function knowledgeRuntimeConfig(
  env: Record<string, string | undefined>,
  manifest: IndexManifest,
  hasInt8: boolean,
): KnowledgeRuntimeConfig {
  const e = manifest.embeddings;
  const bm25Only = env.KB_EMBEDDINGS === 'none' || e.provider === 'none';
  const fromEnv = env.KB_VECTOR_STORE?.toLowerCase() as VectorStoreKind | undefined;
  const store: VectorStoreKind = bm25Only ? 'none' : (fromEnv ?? e.store ?? (hasInt8 ? 'memory' : 'none'));
  const rerankEnv = env.KB_RERANK?.toLowerCase();
  return {
    store,
    bucket: env.KB_VECTOR_BUCKET?.trim() || undefined,
    index: env.KB_VECTOR_INDEX?.trim() || undefined,
    region: env.KB_VECTOR_REGION ?? env.AWS_REGION,
    embedModel: env.KB_EMBED_MODEL?.trim() || undefined,
    embedDims: env.KB_EMBED_DIMS ? Number(env.KB_EMBED_DIMS) : undefined,
    embedRegion: env.KB_EMBED_REGION ?? env.AWS_REGION,
    rerank: rerankEnv ? rerankEnv === 'on' || rerankEnv === 'true' : store === 's3vectors' && !bm25Only,
    rerankModel: env.KB_RERANK_MODEL ?? RERANK_MODEL,
    rerankRegion: env.KB_RERANK_REGION ?? RERANK_REGION,
    rerankRpm: num(env.KB_RERANK_RPM, 3),
    timeouts: {
      embedMs: num(env.KB_EMBED_TIMEOUT_MS, 1500),
      vectorMs: num(env.KB_VECTOR_TIMEOUT_MS, 1500),
      rerankMs: num(env.KB_RERANK_TIMEOUT_MS, 2000),
    },
  };
}

/**
 * Refuse an index whose embedding model/dimension differs from what the runtime is configured to query with: query
 * vectors from another model are meaningless against it (and S3 Vectors would reject a dimension mismatch).
 */
export function assertEmbeddingMatch(
  manifest: IndexManifest,
  cfg: Pick<KnowledgeRuntimeConfig, 'embedModel' | 'embedDims' | 'store'>,
  embedder?: QueryEmbedder,
): void {
  const e = manifest.embeddings;
  if (e.provider === 'none' || cfg.store === 'none') return;
  const problems: string[] = [];
  if (cfg.embedModel && e.model && cfg.embedModel !== e.model)
    problems.push(`model ${e.model} ≠ KB_EMBED_MODEL ${cfg.embedModel}`);
  if (cfg.embedDims && e.dim && cfg.embedDims !== e.dim)
    problems.push(`dims ${e.dim} ≠ KB_EMBED_DIMS ${cfg.embedDims}`);
  if (embedder?.dim && e.dim && embedder.dim !== e.dim)
    problems.push(`dims ${e.dim} ≠ query embedder ${embedder.dim}`);
  if (embedder?.model && e.model && embedder.model !== e.model)
    problems.push(`model ${e.model} ≠ query embedder ${embedder.model}`);
  if (problems.length)
    throw new KnowledgeIndexMismatchError(
      `knowledge index was built with ${e.provider}:${e.model ?? '?'} (${e.dim ?? '?'} dims) but the runtime ` +
        `queries differently: ${problems.join('; ')}. Rebuild with the matching KB_EMBEDDINGS or fix the env.`,
    );
}

async function readFs(dir: string): Promise<Files | null> {
  if (!existsSync(join(dir, INDEX_FILES.manifest))) return null;
  const out: Files = {};
  for (const [k, f] of Object.entries(INDEX_FILES) as [keyof typeof INDEX_FILES, string][]) {
    const p = join(dir, f);
    if (existsSync(p)) out[k] = new Uint8Array(readFileSync(p));
  }
  return out;
}

async function readS3(uri: string): Promise<Files | null> {
  const m = uri.match(/^s3:\/\/([^/]+)\/?(.*)$/);
  if (!m) throw new Error(`bad s3 path ${uri}`);
  const [, bucket, prefix] = m;
  const { S3Client, GetObjectCommand } = await import('@aws-sdk/client-s3');
  const s3 = new S3Client({});
  const out: Files = {};
  await Promise.all(
    (Object.entries(INDEX_FILES) as [keyof typeof INDEX_FILES, string][]).map(async ([k, f]) => {
      try {
        const res = await s3.send(
          new GetObjectCommand({ Bucket: bucket, Key: prefix ? `${prefix.replace(/\/$/, '')}/${f}` : f }),
        );
        out[k] = new Uint8Array(await res.Body!.transformToByteArray());
      } catch (err) {
        if (k === 'manifest' || k === 'chunks' || k === 'bm25') throw err;
      }
    }),
  );
  return out;
}

function withTimeout<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ac.abort();
      reject(new Error(`timeout after ${ms} ms`));
    }, ms);
  });
  return Promise.race([fn(ac.signal), timeout]).finally(() => clearTimeout(timer));
}

/** Small LRU for query embeddings (per container). */
class Lru<V> {
  private readonly m = new Map<string, V>();
  constructor(private readonly max: number) {}
  get(k: string): V | undefined {
    const v = this.m.get(k);
    if (v !== undefined) {
      this.m.delete(k);
      this.m.set(k, v);
    }
    return v;
  }
  set(k: string, v: V) {
    this.m.delete(k);
    this.m.set(k, v);
    if (this.m.size > this.max) this.m.delete(this.m.keys().next().value!);
  }
}

export interface IndexFromFilesOptions extends Pick<
  LoadKnowledgeOptions,
  'embeddings' | 'embedder' | 'modelCacheDir' | 'vectorSearch' | 'reranker' | 'rerankBudget' | 'env'
> {
  /** Lazily load float vectors (the `vectors/` files of a cohere build) for in-memory search. */
  loadFloatVectors?: () => Float32Array[] | null;
}

/** Build a searchable index from in-memory index files (the on-disk format). */
export function indexFromFiles(files: Files, opts: IndexFromFilesOptions = {}): LoadedKnowledgeIndex {
  const env = opts.env ?? process.env;
  const dec = new TextDecoder();
  const manifest = JSON.parse(dec.decode(files.manifest!)) as IndexManifest;
  if (!SUPPORTED_INDEX_VERSIONS.includes(manifest.version))
    throw new Error(`unsupported knowledge index version ${manifest.version}`);
  const chunks = parseChunks(dec.decode(files.chunks!), manifest.chunkDefaults);
  const stats = JSON.parse(dec.decode(files.bm25!)) as Bm25Stats;
  const bm25 = new Bm25Scorer(bm25FromFiles(stats, manifest.bm25, files.postings, files.tf));
  const dim = manifest.embeddings.dim ?? 0;
  const int8 =
    files.embeddings && files.scales && dim > 0
      ? { data: asTyped(files.embeddings, Int8Array), scales: asTyped(files.scales, Float32Array) }
      : undefined;
  const byId = new Map(chunks.map((c, i) => [c.chunkId, i]));
  const keys = chunks.map((c) => c.chunkId);

  const cfg = knowledgeRuntimeConfig(env, manifest, !!int8);
  const denseWanted = opts.embeddings !== 'none' && opts.vectorSearch !== null && cfg.store !== 'none';
  if (denseWanted) assertEmbeddingMatch(manifest, cfg, opts.embedder);

  const allowed = (i: number, q: Pick<VectorQuery, 'collections' | 'jurisdiction'>) => {
    const c = chunks[i];
    if (q.collections?.length && !q.collections.includes(c.collection)) return false;
    if (q.jurisdiction && c.jurisdiction && c.jurisdiction !== q.jurisdiction) return false;
    return true;
  };

  // ------------------------------------------------------------------ vector backend
  let vectorSearch: VectorSearch | null = null;
  if (denseWanted) {
    if (opts.vectorSearch) vectorSearch = opts.vectorSearch;
    else if (cfg.store === 's3vectors' && cfg.bucket && cfg.index)
      vectorSearch = s3VectorSearch({ bucket: cfg.bucket, index: cfg.index, region: cfg.region });
    else if (int8) vectorSearch = memoryVectorSearch(keys, int8Scorer(int8.data, int8.scales, dim), allowed);
    else if (opts.loadFloatVectors) {
      let scorer: ((q: Float32Array, i: number) => number) | null | undefined;
      const lazy = memoryVectorSearch(keys, (q, i) => scorer!(q, i), allowed);
      vectorSearch = {
        kind: 'memory',
        query: (v, q) => {
          if (scorer === undefined) {
            const vecs = opts.loadFloatVectors!();
            scorer = vecs && vecs.length === chunks.length ? floatScorer(vecs) : null;
          }
          if (!scorer) throw new Error('no in-memory vectors for this index (vectors/ missing or stale)');
          return lazy.query(v, q);
        },
      };
    } else
      log('warn', 'dense retrieval configured but no vector backend available; BM25 only', {
        store: cfg.store,
        hasBucket: !!cfg.bucket,
      });
  }

  // ------------------------------------------------------------------ query embedder (lazy, LRU-cached)
  const qCache = new Lru<Float32Array>(QUERY_CACHE_SIZE);
  let embedderPromise: Promise<QueryEmbedder | null> | null = null;
  let embedderReady = false;
  const getEmbedder = () => {
    if (!vectorSearch) return Promise.resolve(null);
    embedderPromise ??= (async () => {
      try {
        const e =
          opts.embedder ??
          (await createEmbedder({
            provider: manifest.embeddings.provider,
            model: manifest.embeddings.model,
            dim: manifest.embeddings.dim,
            region: cfg.embedRegion,
            cacheDir: opts.modelCacheDir ?? env.KB_MODEL_CACHE,
          }));
        if (e) assertEmbeddingMatch(manifest, cfg, e);
        embedderReady = !!e;
        return e;
      } catch (err) {
        if (err instanceof KnowledgeIndexMismatchError) throw err;
        log('warn', 'query embedder unavailable; BM25 only', { error: String(err) });
        return null;
      }
    })();
    return embedderPromise;
  };
  const embedQuery = async (text: string, signal: AbortSignal): Promise<Float32Array> => {
    const hit = qCache.get(text);
    if (hit) return hit;
    const e = await getEmbedder();
    if (!e) throw new Error('no query embedder');
    const [v] = await e.embed([text], { inputType: 'search_query', signal });
    qCache.set(text, v);
    return v;
  };

  // ------------------------------------------------------------------ reranker (only with dense retrieval on; by
  // default only against S3 Vectors, i.e. in AWS — a local in-memory search reranks only with KB_RERANK=on)
  const reranker: Reranker | null =
    opts.reranker !== undefined
      ? opts.reranker
      : cfg.rerank && vectorSearch && (env.KB_RERANK !== undefined || vectorSearch.kind === 's3vectors')
        ? cohereReranker({ model: cfg.rerankModel, region: cfg.rerankRegion })
        : null;

  // An injected reranker (tests) gets an unlimited budget unless one is injected too; the real Bedrock reranker
  // shares one per-container budget sized to the account quota.
  const rerankBudget =
    opts.rerankBudget ??
    (opts.reranker !== undefined
      ? new RerankBudget(0)
      : (sharedRerankBudget ??= new RerankBudget(cfg.rerankRpm)));
  const rerankCache = new Map<string, { index: number; score: number }[]>();
  let trace: SearchTrace | null = null;

  return {
    size: chunks.length,
    manifest,
    mode: () => (vectorSearch && (embedderReady || !!opts.embedder) ? 'hybrid' : 'bm25'),
    lastTrace: () => trace,
    getChunk: (id) => {
      const i = byId.get(id);
      return i === undefined ? undefined : chunks[i];
    },
    async search(q: KnowledgeQuery): Promise<KnowledgeHit[]> {
      const t0 = Date.now();
      const t: SearchTrace = { mode: 'bm25', fallbacks: [], ms: 0 };
      const k = Math.max(1, Math.min(q.k ?? 5, 20));
      const filter = { collections: q.collections, jurisdiction: q.jurisdiction };
      const lexical = [...bm25.score(q.query, (i) => allowed(i, filter)).entries()]
        .sort((a, b) => b[1] - a[1] || a[0] - b[0])
        .slice(0, CANDIDATES);
      const ranks = new Map<number, number>();
      const lexTopDoc = lexical.length ? docIdOf(chunks[lexical[0][0]]) : undefined;
      let denseTopDoc: string | undefined;
      lexical.forEach(([doc], r) => ranks.set(doc, (ranks.get(doc) ?? 0) + 1 / (RRF_K + r + 1)));

      // (b) dense: embed → vector search; any failure falls back to BM25 only.
      if (vectorSearch) {
        let qv: Float32Array | undefined;
        try {
          qv = await withTimeout(cfg.timeouts.embedMs, (signal) => embedQuery(q.query, signal));
        } catch (err) {
          if (err instanceof KnowledgeIndexMismatchError) throw err;
          t.fallbacks.push({ stage: 'embed', error: String(err) });
        }
        if (qv) {
          try {
            const hits = await withTimeout(cfg.timeouts.vectorMs, (signal) =>
              vectorSearch!.query(qv!, { topK: CANDIDATES, ...filter, signal }),
            );
            const dense = hits
              .map((h) => byId.get(h.key))
              .filter((i): i is number => i !== undefined && allowed(i, filter));
            dense.forEach((doc, r) => ranks.set(doc, (ranks.get(doc) ?? 0) + 1 / (RRF_K + r + 1)));
            if (dense.length) denseTopDoc = docIdOf(chunks[dense[0]]);
            t.mode = 'hybrid';
          } catch (err) {
            t.fallbacks.push({ stage: 'vector', error: String(err) });
          }
        }
      }

      // Fuse, then collapse several chunks of one document (report, MEL item, …) to the best-ranked one.
      const fused = [...ranks.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
      const seenDocs = new Set<string>();
      const collapsed = fused.filter(([i]) => {
        const d = docIdOf(chunks[i]);
        if (seenDocs.has(d)) return false;
        seenDocs.add(d);
        return true;
      });

      let ordered: { i: number; score: number; rerankScore?: number }[] = collapsed.map(([i, s]) => ({
        i,
        score: s,
      }));
      if (reranker && collapsed.length > 1) {
        const pool = ordered.slice(0, RERANK_CANDIDATES);
        const apply = (res: { index: number; score: number }[]) => {
          const used = new Set(res.map((r) => r.index));
          ordered = [
            ...res.map((r) => ({ ...pool[r.index], rerankScore: Math.round(r.score * 1e6) / 1e6 })),
            ...pool.filter((_, j) => !used.has(j)),
          ];
          t.mode = t.mode === 'hybrid' ? 'hybrid+rerank' : t.mode;
        };
        const cacheKey = `${q.query}\u0000${pool.map((p) => chunks[p.i].chunkId).join(',')}`;
        const cached = rerankCache.get(cacheKey);
        if (lexTopDoc !== undefined && lexTopDoc === denseTopDoc) {
          // Keyword and vector retrieval agree on the best document: a clear-cut query, keep the fused order.
          t.rerank = 'skipped_agreement';
        } else if (cached) {
          apply(cached);
          t.rerank = 'cached';
        } else if (!rerankBudget.tryTake()) {
          t.rerank = 'skipped_budget';
        } else {
          try {
            const res = await withTimeout(cfg.timeouts.rerankMs, (signal) =>
              reranker.rerank(
                q.query,
                pool.map((p) => indexText(chunks[p.i]).slice(0, RERANK_DOC_CHARS)),
                Math.min(k, pool.length),
                signal,
              ),
            );
            if (!res.length) throw new Error('empty rerank result');
            apply(res);
            t.rerank = 'applied';
            if (rerankCache.size >= RERANK_CACHE_SIZE) rerankCache.delete(rerankCache.keys().next().value!);
            rerankCache.set(cacheKey, res);
          } catch (err) {
            if (isThrottle(err)) rerankBudget.drain();
            t.rerank = 'failed';
            t.fallbacks.push({ stage: 'rerank', error: String(err) });
          }
        }
      }

      t.ms = Date.now() - t0;
      trace = t;
      if (t.fallbacks.length)
        log('warn', 'knowledge search degraded', {
          mode: t.mode,
          fallbacks: t.fallbacks,
          ms: t.ms,
          collections: q.collections,
        });

      return ordered.slice(0, k).map(({ i, score, rerankScore }) => {
        const c = chunks[i];
        const hit: KnowledgeHit = {
          chunkId: c.chunkId,
          sourceId: c.sourceId,
          url: c.url,
          title: c.title,
          collection: c.collection,
          text: c.text,
          score: Math.round(score * 1e6) / 1e6,
        };
        if (c.section) hit.section = c.section;
        if (c.jurisdiction) hit.jurisdiction = c.jurisdiction;
        if (c.date) hit.date = c.date;
        if (c.docId) hit.docId = c.docId;
        if (c.header) hit.header = c.header;
        if (rerankScore !== undefined) hit.rerankScore = rerankScore;
        return hit;
      });
    },
  };
}

/** An in-memory BM25 index over chunk records (evals: `knowledgeInjection`; tests). */
export function createInMemoryIndex(chunks: ChunkRecord[]): LoadedKnowledgeIndex {
  const files = serialiseIndex(chunks, {
    builtAt: new Date(0).toISOString(),
    embeddings: { provider: 'none' },
    sources: [],
  });
  const enc = new TextEncoder();
  const asBytes = (v: Uint8Array | string) => (typeof v === 'string' ? enc.encode(v) : v);
  const byName = Object.fromEntries(Object.entries(files).map(([n, v]) => [n, asBytes(v)]));
  const f: Files = {};
  for (const [k, name] of Object.entries(INDEX_FILES) as [keyof typeof INDEX_FILES, string][])
    if (byName[name]) f[k] = byName[name];
  return indexFromFiles(f, { embeddings: 'none' });
}

const EMPTY: LoadedKnowledgeIndex = {
  size: 0,
  manifest: null,
  mode: () => 'bm25',
  lastTrace: () => null,
  getChunk: () => undefined,
  search: async () => [],
};

/** Float vectors of a cohere build (`vectors/embeddings.f32`) next to an on-disk index, if present. */
function floatVectorsLoader(dir: string, dim: number): () => Float32Array[] | null {
  return () => {
    const p = join(dir, VECTOR_FILES.data);
    if (!dim || !existsSync(p)) return null;
    return vectorsFromBytes(new Uint8Array(readFileSync(p)), dim);
  };
}

/**
 * Load (and cache per container) a knowledge index. A missing index yields an empty index with a warning, so runs
 * still work before `npm run kb:build` / `kb:upload`. An embedding model/dimension mismatch between the index and
 * the runtime configuration is refused (KnowledgeIndexMismatchError).
 */
export async function loadKnowledgeIndex(opts: LoadKnowledgeOptions): Promise<LoadedKnowledgeIndex> {
  const injected = !!(
    opts.embedder ||
    opts.vectorSearch !== undefined ||
    opts.reranker !== undefined ||
    opts.env
  );
  const key = `${opts.source}:${opts.path}:${opts.embeddings ?? 'auto'}`;
  if (!opts.noCache && !injected) {
    const hit = cache.get(key);
    if (hit) return hit;
  }
  const p = (async () => {
    const t0 = Date.now();
    const files = opts.source === 's3' ? await readS3(opts.path) : await readFs(opts.path);
    if (!files?.manifest || !files.chunks || !files.bm25) {
      log('warn', 'knowledge index not found; searches return no hits', { path: opts.path });
      return EMPTY;
    }
    const manifestDim = (JSON.parse(new TextDecoder().decode(files.manifest)) as IndexManifest).embeddings
      .dim;
    const idx = indexFromFiles(files, {
      ...opts,
      loadFloatVectors: opts.source === 'fs' ? floatVectorsLoader(opts.path, manifestDim ?? 0) : undefined,
    });
    log('info', 'knowledge index loaded', {
      path: opts.path,
      chunks: idx.size,
      ms: Date.now() - t0,
      embeddings: idx.manifest?.embeddings.provider,
      store: idx.manifest?.embeddings.store,
    });
    return idx;
  })();
  if (!opts.noCache && !injected) {
    cache.set(key, p);
    p.catch(() => cache.delete(key));
  }
  return p;
}
