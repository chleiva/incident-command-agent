/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * On-disk knowledge index format (`data/index/`, `data/fixtures/index/`), version 1.
 *
 *   manifest.json    IndexManifest
 *   chunks.jsonl     one ChunkRecord per line, in doc order (doc index = line number)
 *   bm25.json        Bm25Stats (terms, per-term offsets into the postings, doc lengths)
 *   postings.bin     Uint32 doc indexes for every term, concatenated in `terms` order
 *   tf.bin           Uint16 term frequencies aligned with postings.bin
 *   embeddings.bin   Int8 vectors, N × dim (only when manifest.embeddings.provider !== 'none')
 *   scales.bin       Float32 per-vector dequantisation scale, N
 */
import type { Jurisdiction, KnowledgeCollection } from '@ica/schema';
import { tokenize } from './text';

export const INDEX_VERSION = 1;
export const INDEX_FILES = {
  manifest: 'manifest.json',
  chunks: 'chunks.jsonl',
  bm25: 'bm25.json',
  postings: 'postings.bin',
  tf: 'tf.bin',
  embeddings: 'embeddings.bin',
  scales: 'scales.bin',
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
  text: string;
  /** Free metadata (e.g. NASA ASRS disclaimer, MEL category). */
  meta?: Record<string, string>;
}

export type EmbeddingProvider = 'local' | 'openai' | 'bedrock' | 'none';

export interface IndexManifest {
  version: typeof INDEX_VERSION;
  builtAt: string;
  chunkCount: number;
  embeddings: { provider: EmbeddingProvider; model?: string; dim?: number; quantisation?: 'int8' };
  bm25: { k1: number; b: number };
  sources: { sourceId: string; collection: KnowledgeCollection; chunks: number; licence: string }[];
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
  manifest: Omit<IndexManifest, 'chunkCount' | 'bm25' | 'version'>,
  embeddings?: { vectors: Float32Array[]; dim: number },
): Record<string, Uint8Array | string> {
  const bm = buildBm25(chunks.map(indexText));
  const full: IndexManifest = {
    version: INDEX_VERSION,
    chunkCount: chunks.length,
    bm25: { k1: bm.stats.k1, b: bm.stats.b },
    ...manifest,
  };
  const files: Record<string, Uint8Array | string> = {
    [INDEX_FILES.manifest]: JSON.stringify(full, null, 2) + '\n',
    [INDEX_FILES.chunks]: chunks.map((c) => JSON.stringify(c)).join('\n') + '\n',
    [INDEX_FILES.bm25]: JSON.stringify(bm.stats),
    [INDEX_FILES.postings]: new Uint8Array(bm.docs.buffer, bm.docs.byteOffset, bm.docs.byteLength),
    [INDEX_FILES.tf]: new Uint8Array(bm.tf.buffer, bm.tf.byteOffset, bm.tf.byteLength),
  };
  if (embeddings && manifest.embeddings.provider !== 'none') {
    const q = quantise(embeddings.vectors, embeddings.dim);
    files[INDEX_FILES.embeddings] = new Uint8Array(q.data.buffer, q.data.byteOffset, q.data.byteLength);
    files[INDEX_FILES.scales] = new Uint8Array(q.scales.buffer, q.scales.byteOffset, q.scales.byteLength);
  }
  return files;
}

/** The text BM25 and embeddings see: title + section + body (so titles are searchable). */
export function indexText(c: ChunkRecord): string {
  return [c.title, c.section, c.text].filter(Boolean).join('\n');
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

export function parseChunks(jsonl: string): ChunkRecord[] {
  return jsonl
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as ChunkRecord);
}
