/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * On-disk knowledge index format (`data/index/`, `data/fixtures/index/`), version 2 (version 1 still loads).
 *
 *   manifest.json    IndexManifest
 *   chunks.jsonl     one ChunkRecord per line, in doc order (doc index = line number)
 *   bm25.json        Bm25Stats (terms, per-term offsets into the postings, doc lengths)
 *   postings.bin     v1: Uint32 doc indexes per term in `terms` order; v2: varint doc deltas + tf (encodePostings)
 *   tf.bin           v1 only: Uint16 term frequencies aligned with postings.bin
 *   embeddings.bin   Int8 vectors, N × dim (only when embeddings are stored in memory, `embeddings.store: 'memory'`)
 *   scales.bin       Float32 per-vector dequantisation scale, N
 *
 * With `embeddings.store: 's3vectors'` the vectors are NOT part of the Lambda-loaded files: the build writes them to
 * `vectors/` (float32 `embeddings.f32` + `keys.jsonl` with the S3 Vectors key and filterable metadata per line), and
 * `npm run kb:upload` puts them into the S3 Vectors index. Version 2 adds `ChunkRecord.docId` and `header` (the
 * structural context header that is embedded and BM25-indexed with the text, stored apart so quotes stay verbatim).
 */
import type { Jurisdiction, KnowledgeCollection } from '@ica/schema';
import { tokenize } from './text';

export const INDEX_VERSION = 2;
export const SUPPORTED_INDEX_VERSIONS: readonly number[] = [1, 2];
export const INDEX_FILES = {
  manifest: 'manifest.json',
  chunks: 'chunks.jsonl',
  bm25: 'bm25.json',
  postings: 'postings.bin',
  tf: 'tf.bin',
  embeddings: 'embeddings.bin',
  scales: 'scales.bin',
} as const;

/** Vectors for the external store (not loaded by the Lambdas; synced by `kb:upload`). */
export const VECTOR_FILES = {
  dir: 'vectors',
  data: 'vectors/embeddings.f32',
  keys: 'vectors/keys.jsonl',
} as const;

export interface ChunkRecord {
  chunkId: string;
  sourceId: string;
  url: string;
  title: string;
  section?: string;
  jurisdiction?: Jurisdiction;
  date?: string;
  collection: KnowledgeCollection;
  licence: string;
  /** Verbatim source text (citation quotes are always substrings of this). */
  text: string;
  /**
   * The logical document this chunk belongs to (an MEL item, a rule sub-paragraph, an article, a report). Retrieval
   * collapses several hits of one docId to the best one. Defaults to the chunkId.
   */
  docId?: string;
  /**
   * Deterministic structural context header (`source › section path › jurisdiction › date`, plus a report synopsis
   * or MEL item header). Prepended to the text for embedding and BM25; never part of a quote.
   */
  header?: string;
  /** Free metadata (e.g. NASA ASRS disclaimer, MEL category). */
  meta?: Record<string, string>;
}

/** `bedrock` is a deprecated alias of `cohere` (Cohere Embed v4 on Amazon Bedrock). */
export type EmbeddingProvider = 'local' | 'openai' | 'cohere' | 'bedrock' | 'none';

/** Where the dense vectors live: in the Lambda-loaded index (int8), in Amazon S3 Vectors, or nowhere. */
export type VectorStoreKind = 'memory' | 's3vectors' | 'none';

export interface ChunkStats {
  chunks: number;
  docs: number;
  tokens: { total: number; mean: number; p10: number; p50: number; p90: number; max: number };
  /** Docs split into more than one chunk. */
  splitDocs: number;
}

export interface IndexManifest {
  version: number;
  builtAt: string;
  chunkCount: number;
  embeddings: {
    provider: EmbeddingProvider;
    model?: string;
    dim?: number;
    quantisation?: 'int8';
    /** Bedrock inference profile or region the model was invoked through (cohere). */
    profile?: string;
    /** Input type used for the chunk embeddings (cohere: `search_document`; queries use `search_query`). */
    inputType?: string;
    /** Where the vectors are stored (default `memory` when embeddings.bin exists). */
    store?: VectorStoreKind;
    vectorCount?: number;
  };
  /** v2: `varint-delta-tf` = doc deltas and term frequencies interleaved in postings.bin (no tf.bin). */
  bm25: { k1: number; b: number; encoding?: 'varint-delta-tf' };
  /** v2: per-group shared chunk fields (see `compactChunks`). */
  chunkDefaults?: Record<string, Partial<ChunkRecord>>;
  sources: { sourceId: string; collection: KnowledgeCollection; chunks: number; licence: string }[];
  /** Per-collection chunking statistics (token estimate ≈ words / 0.75). */
  chunking?: Record<string, ChunkStats>;
  notes?: string[];
}

export interface Bm25Stats {
  k1: number;
  b: number;
  n: number;
  avgdl: number;
  docLen: number[];
  terms: string[];
  /** offsets[i]..offsets[i+1] slice of postings for terms[i]; length terms.length + 1. */
  offsets: number[];
}

export interface Bm25Postings {
  stats: Bm25Stats;
  docs: Uint32Array;
  tf: Uint16Array;
}

/** Build BM25 statistics and postings for the given texts. */
export function buildBm25(texts: string[], k1 = 1.2, b = 0.75): Bm25Postings {
  const perTerm = new Map<string, [number, number][]>();
  const docLen: number[] = [];
  texts.forEach((text, doc) => {
    const toks = tokenize(text);
    docLen.push(toks.length);
    const counts = new Map<string, number>();
    for (const t of toks) counts.set(t, (counts.get(t) ?? 0) + 1);
    for (const [t, c] of counts) {
      let list = perTerm.get(t);
      if (!list) perTerm.set(t, (list = []));
      list.push([doc, Math.min(c, 65535)]);
    }
  });
  const terms = [...perTerm.keys()].sort();
  const offsets: number[] = [0];
  let total = 0;
  for (const t of terms) offsets.push((total += perTerm.get(t)!.length));
  const docs = new Uint32Array(total);
  const tf = new Uint16Array(total);
  let i = 0;
  for (const t of terms) {
    for (const [d, c] of perTerm.get(t)!) {
      docs[i] = d;
      tf[i] = c;
      i++;
    }
  }
  const n = texts.length;
  const avgdl = n ? docLen.reduce((a, x) => a + x, 0) / n : 0;
  return { stats: { k1, b, n, avgdl, docLen, terms, offsets }, docs, tf };
}

/** A queryable BM25 view over stats + postings. */
export class Bm25Scorer {
  private readonly termIndex = new Map<string, number>();
  constructor(private readonly p: Bm25Postings) {
    p.stats.terms.forEach((t, i) => this.termIndex.set(t, i));
  }

  /** Scores for every doc with at least one matching term (optionally only docs passing `filter`). */
  score(query: string, filter?: (doc: number) => boolean): Map<number, number> {
    const { k1, b, n, avgdl, docLen, offsets } = this.p.stats;
    const scores = new Map<number, number>();
    const qTerms = [...new Set(tokenize(query))];
    for (const t of qTerms) {
      const ti = this.termIndex.get(t);
      if (ti === undefined) continue;
      const start = offsets[ti];
      const end = offsets[ti + 1];
      const df = end - start;
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      for (let i = start; i < end; i++) {
        const d = this.p.docs[i];
        if (filter && !filter(d)) continue;
        const f = this.p.tf[i];
        const norm = f + k1 * (1 - b + (b * docLen[d]) / (avgdl || 1));
        scores.set(d, (scores.get(d) ?? 0) + (idf * (f * (k1 + 1))) / norm);
      }
    }
    return scores;
  }
}

/** Quantise L2-normalised float vectors to int8 with a per-vector scale. */
export function quantise(vectors: Float32Array[], dim: number): { data: Int8Array; scales: Float32Array } {
  const data = new Int8Array(vectors.length * dim);
  const scales = new Float32Array(vectors.length);
  vectors.forEach((v, i) => {
    let max = 0;
    for (let j = 0; j < dim; j++) max = Math.max(max, Math.abs(v[j]));
    const scale = max > 0 ? max / 127 : 1;
    scales[i] = scale;
    for (let j = 0; j < dim; j++) data[i * dim + j] = Math.round(v[j] / scale);
  });
  return { data, scales };
}

/** Cosine similarity between a float query (L2-normalised) and quantised doc `i`. */
export function cosineQuantised(
  q: Float32Array,
  data: Int8Array,
  scales: Float32Array,
  i: number,
  dim: number,
): number {
  let dot = 0;
  let norm = 0;
  const off = i * dim;
  for (let j = 0; j < dim; j++) {
    const x = data[off + j];
    dot += q[j] * x;
    norm += x * x;
  }
  const s = scales[i];
  const denom = Math.sqrt(norm) * s;
  return denom > 0 ? (dot * s) / denom : 0;
}

export function l2normalise(v: Float32Array): Float32Array {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return v.map((x) => x / n);
}

/** Serialise an index to a map of file name → bytes (the build writes them to disk; tests keep them in memory). */
export function serialiseIndex(
  chunks: ChunkRecord[],
  manifest: Omit<IndexManifest, 'chunkCount' | 'bm25' | 'version' | 'chunkDefaults'>,
  embeddings?: { vectors: Float32Array[]; dim: number },
): Record<string, Uint8Array | string> {
  const store = manifest.embeddings.store ?? (manifest.embeddings.provider === 'none' ? 'none' : 'memory');
  const bm = buildBm25(chunks.map(indexText));
  const compact = compactChunks(chunks);
  const postings = encodePostings(bm.docs, bm.tf, bm.stats.offsets);
  const full: IndexManifest = {
    version: INDEX_VERSION,
    chunkCount: chunks.length,
    bm25: { k1: bm.stats.k1, b: bm.stats.b, encoding: 'varint-delta-tf' },
    ...manifest,
    chunkDefaults: compact.defaults,
  };
  const files: Record<string, Uint8Array | string> = {
    [INDEX_FILES.manifest]: JSON.stringify(full, null, 2) + '\n',
    [INDEX_FILES.chunks]: compact.lines.join('\n') + '\n',
    [INDEX_FILES.bm25]: JSON.stringify(bm.stats),
    [INDEX_FILES.postings]: postings,
  };
  if (embeddings && manifest.embeddings.provider !== 'none' && store === 'memory') {
    const q = quantise(embeddings.vectors, embeddings.dim);
    files[INDEX_FILES.embeddings] = new Uint8Array(q.data.buffer, q.data.byteOffset, q.data.byteLength);
    files[INDEX_FILES.scales] = new Uint8Array(q.scales.buffer, q.scales.byteOffset, q.scales.byteLength);
  }
  return files;
}

// ------------------------------------------------------------------------------------------------ compaction
/** Fields shared by every chunk of a group that are stored once in `manifest.chunkDefaults`. */
const GROUP_FIELDS = ['url', 'licence', 'jurisdiction', 'collection', 'date'] as const;
const GROUP_META = ['disclaimer', 'attribution'] as const;
/** Metadata only needed at build time (S3 Vectors filter metadata; already in the context header). */
const BUILD_ONLY_META = new Set(['phase', 'aircraftType']);

/** Group of a chunk for compaction: the chunkId prefix (`asrs`, `mmel`, `easa`, `aaib` …). */
export const chunkGroup = (c: ChunkRecord) => c.chunkId.split(/[-#]/)[0];

/**
 * Store fields that are identical across a group (licence, url, NASA disclaimer …) once per group. Lines carry `g`
 * and omit those fields; `parseChunks(jsonl, manifest.chunkDefaults)` restores them.
 */
export function compactChunks(chunks: ChunkRecord[]): {
  lines: string[];
  defaults: Record<string, Partial<ChunkRecord>>;
} {
  const groups = new Map<string, ChunkRecord[]>();
  for (const c of chunks) {
    const g = chunkGroup(c);
    const l = groups.get(g) ?? [];
    l.push(c);
    groups.set(g, l);
  }
  const defaults: Record<string, Partial<ChunkRecord>> = {};
  for (const [g, list] of groups) {
    if (list.length < 2) continue;
    const d: Partial<ChunkRecord> & { meta?: Record<string, string> } = {};
    for (const f of GROUP_FIELDS) {
      const v = list[0][f];
      if (v !== undefined && list.every((c) => c[f] === v)) (d as Record<string, unknown>)[f] = v;
    }
    for (const k of GROUP_META) {
      const v = list[0].meta?.[k];
      if (v !== undefined && list.every((c) => c.meta?.[k] === v)) (d.meta ??= {})[k] = v;
    }
    if (Object.keys(d).length) defaults[g] = d;
  }
  const lines = chunks.map((c) => {
    const g = chunkGroup(c);
    const d = defaults[g];
    if (!d) return JSON.stringify(c);
    const out: Record<string, unknown> = { g };
    for (const [k, v] of Object.entries(c)) {
      if (k === 'meta') continue;
      if ((d as Record<string, unknown>)[k] === v) continue;
      out[k] = v;
    }
    if (c.meta) {
      const meta = Object.fromEntries(
        Object.entries(c.meta).filter(([k, v]) => d.meta?.[k] !== v && !BUILD_ONLY_META.has(k)),
      );
      if (Object.keys(meta).length) out.meta = meta;
    }
    return JSON.stringify(out);
  });
  return { lines, defaults };
}

/**
 * Postings with term frequencies interleaved: per posting a LEB128 varint of `(docDelta << 1) | (tf > 1)`, followed
 * by one byte `min(tf, 255)` only when tf > 1 (most postings have tf = 1). Each term's list restarts from doc 0.
 */
export function encodePostings(docs: Uint32Array, tf: Uint16Array, offsets: number[]): Uint8Array {
  const out: number[] = [];
  for (let t = 0; t + 1 < offsets.length; t++) {
    let prev = 0;
    for (let i = offsets[t]; i < offsets[t + 1]; i++) {
      const f = Math.min(tf[i], 255);
      let v = (docs[i] - prev) * 2 + (f > 1 ? 1 : 0);
      prev = docs[i];
      while (v >= 0x80) {
        out.push((v % 0x80) | 0x80);
        v = Math.floor(v / 0x80);
      }
      out.push(v);
      if (f > 1) out.push(f);
    }
  }
  return Uint8Array.from(out);
}

export function decodePostings(bytes: Uint8Array, offsets: number[]): { docs: Uint32Array; tf: Uint16Array } {
  const total = offsets[offsets.length - 1] ?? 0;
  const docs = new Uint32Array(total);
  const tf = new Uint16Array(total);
  let p = 0;
  for (let t = 0; t + 1 < offsets.length; t++) {
    let prev = 0;
    for (let i = offsets[t]; i < offsets[t + 1]; i++) {
      let v = 0;
      let mul = 1;
      let b: number;
      do {
        b = bytes[p++];
        v += (b & 0x7f) * mul;
        mul *= 0x80;
      } while (b & 0x80);
      prev += Math.floor(v / 2);
      docs[i] = prev;
      tf[i] = v % 2 ? bytes[p++] : 1;
    }
  }
  return { docs, tf };
}

/** Rebuild BM25 postings from index files (v1: raw Uint32 docs + Uint16 tf; v2: interleaved varint postings). */
export function bm25FromFiles(
  stats: Bm25Stats,
  bm25: IndexManifest['bm25'],
  postings: Uint8Array | undefined,
  tf: Uint8Array | undefined,
): Bm25Postings {
  const p = postings ?? new Uint8Array();
  if (bm25.encoding === 'varint-delta-tf') return { stats, ...decodePostings(p, stats.offsets) };
  return { stats, docs: asTyped(p, Uint32Array), tf: asTyped(tf ?? new Uint8Array(), Uint16Array) };
}

/** Aggregate per-source chunk counts by source family (ASRS reports, MMEL items, … are one row each). */
export function sourceFamily(sourceId: string): string {
  return sourceId
    .replace(/^(ASRS) ACN \d+$/, '$1')
    .replace(/^(FAA MMEL A-320) .+$/, '$1')
    .replace(/^(EU Reg 261\/2004) .+$/, '$1')
    .replace(/^(EASA) .+$/, '$1 Easy Access Rules for Air Operations')
    .replace(/^(AAIB) .+$/, '$1');
}

/**
 * The text BM25 and embeddings see: the structural context header + the verbatim text (v2), or title + section +
 * text for chunks without a header (v1 indexes, hand-made in-memory chunks).
 */
export function indexText(c: ChunkRecord): string {
  if (c.header) return `${c.header}\n\n${c.text}`;
  return [c.title, c.section, c.text].filter(Boolean).join('\n');
}

/** The docId used for collapsing (the chunkId when a chunk has none). */
export const docIdOf = (c: ChunkRecord): string => c.docId ?? c.chunkId;

/** Jurisdiction value stored in vector metadata for chunks without one (they match every jurisdiction filter). */
export const ANY_JURISDICTION = 'ANY';

const META_MAX = 120;
const clip = (s: string) => (s.length > META_MAX ? s.slice(0, META_MAX) : s);

/**
 * Filterable S3 Vectors metadata for a chunk (well under the 2 KB filterable-metadata limit: ≤ 8 keys, values clipped
 * to 120 chars). Text is NOT stored in the vector store: it stays in the S3 chunk files.
 */
export function vectorMetadata(c: ChunkRecord): Record<string, string> {
  const m: Record<string, string> = {
    collection: c.collection,
    jurisdiction: c.jurisdiction ?? ANY_JURISDICTION,
    sourceId: clip(c.sourceId),
    docId: clip(docIdOf(c)),
  };
  const meta = c.meta ?? {};
  if (c.collection === 'mel') {
    if (meta.itemNumber) m.itemNumber = meta.itemNumber;
    if (meta.ataChapter) m.ataChapter = meta.ataChapter;
  }
  if (c.collection === 'precedent') {
    if (meta.phase) m.phase = clip(meta.phase);
    if (meta.aircraftType) m.aircraftType = clip(meta.aircraftType);
  }
  return m;
}

/** S3 Vectors metadata filter for a query (collections and jurisdiction; chunks without a jurisdiction always pass). */
export function vectorFilter(q: {
  collections?: readonly string[];
  jurisdiction?: string;
}): Record<string, unknown> | undefined {
  const parts: Record<string, unknown>[] = [];
  if (q.collections?.length)
    parts.push(
      q.collections.length === 1
        ? { collection: { $eq: q.collections[0] } }
        : { collection: { $in: [...q.collections] } },
    );
  if (q.jurisdiction) parts.push({ jurisdiction: { $in: [q.jurisdiction, ANY_JURISDICTION] } });
  if (!parts.length) return undefined;
  return parts.length === 1 ? parts[0] : { $and: parts };
}

/** Serialise float vectors (row-major N × dim) to little-endian float32 bytes, and back. */
export function vectorsToBytes(vectors: Float32Array[], dim: number): Uint8Array {
  const out = new Float32Array(vectors.length * dim);
  vectors.forEach((v, i) => out.set(v.subarray(0, dim), i * dim));
  return new Uint8Array(out.buffer);
}

export function vectorsFromBytes(bytes: Uint8Array, dim: number): Float32Array[] {
  const all = asTyped(bytes, Float32Array);
  const n = Math.floor(all.length / dim);
  return Array.from({ length: n }, (_, i) => all.subarray(i * dim, (i + 1) * dim));
}

/** Copy bytes into a fresh, aligned buffer and view them as a typed array. */
export function asTyped<T extends Uint32Array | Uint16Array | Int8Array | Float32Array>(
  bytes: Uint8Array,
  ctor: { new (buf: ArrayBuffer): T },
): T {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new ctor(copy.buffer);
}

export function parseChunks(
  jsonl: string,
  defaults: Record<string, Partial<ChunkRecord>> = {},
): ChunkRecord[] {
  return jsonl
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      const raw = JSON.parse(l) as ChunkRecord & { g?: string };
      if (!raw.g) return raw;
      const { g, ...c } = raw;
      const d = defaults[g] ?? {};
      const meta = d.meta || c.meta ? { ...d.meta, ...c.meta } : undefined;
      return { ...d, ...c, ...(meta ? { meta } : {}) } as ChunkRecord;
    });
}
