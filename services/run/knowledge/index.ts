/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Knowledge index loader + hybrid retrieval (spec §9): BM25 plus cosine over int8 embeddings, fused with reciprocal
 * rank fusion, filtered by collection and jurisdiction. Reads `data/index/` (or `data/fixtures/index/`) from the
 * file system, or the same files from S3 (`s3://bucket/prefix`). Loaded indexes are cached for the container's
 * lifetime. If the query embedder cannot load (no model files, no network), search degrades to BM25 only.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Bm25Scorer,
  INDEX_FILES,
  asTyped,
  cosineQuantised,
  createEmbedder,
  parseChunks,
  serialiseIndex,
  type Bm25Stats,
  type ChunkRecord,
  type IndexManifest,
} from '@ica/kb';
import type { KnowledgeHit, KnowledgeIndex, KnowledgeQuery } from '@ica/schema';

export interface QueryEmbedder {
  embed(texts: string[]): Promise<Float32Array[]>;
}

export interface LoadKnowledgeOptions {
  source: 'fs' | 's3';
  /** Directory (fs) or s3://bucket/prefix (s3). */
  path: string;
  /**
   * 'auto' (default): embed queries with the provider recorded in the manifest, falling back to BM25 on failure.
   * 'none': BM25 only. Env `KB_EMBEDDINGS=none` also forces BM25.
   */
  embeddings?: 'auto' | 'none';
  /** Inject a query embedder (tests; or a pre-warmed one). */
  embedder?: QueryEmbedder;
  /** Where the local model files live / are cached (Lambda: a /tmp path or files synced from S3). */
  modelCacheDir?: string;
  /** Skip the per-container cache. */
  noCache?: boolean;
}

export interface LoadedKnowledgeIndex extends KnowledgeIndex {
  readonly size: number;
  readonly manifest: IndexManifest | null;
  /** 'hybrid' when query embeddings are available, otherwise 'bm25'. */
  mode(): 'hybrid' | 'bm25';
  getChunk(chunkId: string): ChunkRecord | undefined;
}

type Files = Partial<Record<keyof typeof INDEX_FILES, Uint8Array>>;

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
const CANDIDATES = 50;
const cache = new Map<string, Promise<LoadedKnowledgeIndex>>();
const log = (msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ level: 'info', component: 'knowledge', msg, ...extra }));

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

/** Build a searchable index from in-memory index files (the on-disk format). */
export function indexFromFiles(
  files: Files,
  opts: Pick<LoadKnowledgeOptions, 'embeddings' | 'embedder' | 'modelCacheDir'> = {},
): LoadedKnowledgeIndex {
  const dec = new TextDecoder();
  const manifest = JSON.parse(dec.decode(files.manifest!)) as IndexManifest;
  const chunks = parseChunks(dec.decode(files.chunks!));
  const stats = JSON.parse(dec.decode(files.bm25!)) as Bm25Stats;
  const bm25 = new Bm25Scorer({
    stats,
    docs: asTyped(files.postings ?? new Uint8Array(), Uint32Array),
    tf: asTyped(files.tf ?? new Uint8Array(), Uint16Array),
  });
  const dim = manifest.embeddings.dim ?? 0;
  const vectors =
    files.embeddings && files.scales && dim > 0
      ? { data: asTyped(files.embeddings, Int8Array), scales: asTyped(files.scales, Float32Array) }
      : undefined;
  const byId = new Map(chunks.map((c, i) => [c.chunkId, i]));

  const wantEmbeddings =
    opts.embeddings !== 'none' &&
    process.env.KB_EMBEDDINGS !== 'none' &&
    !!vectors &&
    manifest.embeddings.provider !== 'none';
  let embedderPromise: Promise<QueryEmbedder | null> | null = null;
  let embedderReady = false;
  const getEmbedder = () => {
    if (!wantEmbeddings) return Promise.resolve(null);
    embedderPromise ??= (async () => {
      try {
        const e =
          opts.embedder ??
          (await createEmbedder({
            provider: manifest.embeddings.provider,
            model: manifest.embeddings.model,
            cacheDir: opts.modelCacheDir ?? process.env.KB_MODEL_CACHE,
          }));
        embedderReady = !!e;
        return e;
      } catch (err) {
        log('query embedder unavailable; BM25 only', { error: String(err) });
        return null;
      }
    })();
    return embedderPromise;
  };

  return {
    size: chunks.length,
    manifest,
    mode: () => (embedderReady ? 'hybrid' : 'bm25'),
    getChunk: (id) => {
      const i = byId.get(id);
      return i === undefined ? undefined : chunks[i];
    },
    async search(q: KnowledgeQuery): Promise<KnowledgeHit[]> {
      const k = Math.max(1, Math.min(q.k ?? 5, 20));
      const cols = q.collections?.length ? new Set(q.collections) : undefined;
      const allowed = (i: number) => {
        const c = chunks[i];
        if (cols && !cols.has(c.collection)) return false;
        if (q.jurisdiction && c.jurisdiction && c.jurisdiction !== q.jurisdiction) return false;
        return true;
      };
      const lexical = [...bm25.score(q.query, allowed).entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, CANDIDATES);
      const ranks = new Map<number, number>();
      lexical.forEach(([doc], r) => ranks.set(doc, (ranks.get(doc) ?? 0) + 1 / (RRF_K + r + 1)));
      const embedder = await getEmbedder();
      if (embedder && vectors) {
        const [qv] = await embedder.embed([q.query]);
        const sims: [number, number][] = [];
        for (let i = 0; i < chunks.length; i++)
          if (allowed(i)) sims.push([i, cosineQuantised(qv, vectors.data, vectors.scales, i, dim)]);
        sims.sort((a, b) => b[1] - a[1]);
        sims
          .slice(0, CANDIDATES)
          .forEach(([doc], r) => ranks.set(doc, (ranks.get(doc) ?? 0) + 1 / (RRF_K + r + 1)));
      }
      return [...ranks.entries()]
        .sort((a, b) => b[1] - a[1] || a[0] - b[0])
        .slice(0, k)
        .map(([i, score]) => {
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
  getChunk: () => undefined,
  search: async () => [],
};

/**
 * Load (and cache per container) a knowledge index. A missing index yields an empty index with a warning, so runs
 * still work before `npm run kb:build` / `kb:upload`.
 */
export async function loadKnowledgeIndex(opts: LoadKnowledgeOptions): Promise<LoadedKnowledgeIndex> {
  const key = `${opts.source}:${opts.path}:${opts.embeddings ?? 'auto'}`;
  if (!opts.noCache && !opts.embedder) {
    const hit = cache.get(key);
    if (hit) return hit;
  }
  const p = (async () => {
    const t0 = Date.now();
    const files = opts.source === 's3' ? await readS3(opts.path) : await readFs(opts.path);
    if (!files?.manifest || !files.chunks || !files.bm25) {
      log('knowledge index not found; searches return no hits', { path: opts.path });
      return EMPTY;
    }
    const idx = indexFromFiles(files, opts);
    log('knowledge index loaded', { path: opts.path, chunks: idx.size, ms: Date.now() - t0 });
    return idx;
  })();
  if (!opts.noCache && !opts.embedder) {
    cache.set(key, p);
    p.catch(() => cache.delete(key));
  }
  return p;
}
