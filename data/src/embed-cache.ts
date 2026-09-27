/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Resumable embedding cache for kb:build: vectors are keyed by a hash of the exact embedded text (header + chunk),
 * appended to a JSONL file after every batch, so an interrupted or repeated build never pays twice for a chunk.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import type { Embedder } from './embed';

export const textHash = (text: string) => createHash('sha1').update(text).digest('hex');

export interface VectorCache {
  get(hash: string): Float32Array | undefined;
  has(hash: string): boolean;
  /** Persist new entries (append-only). */
  put(entries: { hash: string; vector: Float32Array }[]): void;
  readonly size: number;
}

const encode = (v: Float32Array) => Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64');
const decode = (s: string) => {
  const b = Buffer.from(s, 'base64');
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
};

/** In-memory cache (tests) or one backed by an append-only JSONL file `{h, v}` per line. */
export function openVectorCache(file?: string): VectorCache {
  const map = new Map<string, Float32Array>();
  const raw = file && existsSync(file) ? readFileSync(file, 'utf8') : '';
  // Terminate a torn last line so the next append starts on a fresh line.
  if (file && raw && !raw.endsWith('\n')) appendFileSync(file, '\n');
  if (raw)
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try {
        const { h, v } = JSON.parse(line) as { h: string; v: string };
        map.set(h, decode(v));
      } catch {
        // A torn last line from an interrupted build: ignore it (the chunk is re-embedded).
      }
    }
  return {
    get: (h) => map.get(h),
    has: (h) => map.has(h),
    get size() {
      return map.size;
    },
    put(entries) {
      if (!entries.length) return;
      for (const e of entries) map.set(e.hash, e.vector);
      if (file)
        appendFileSync(
          file,
          entries.map((e) => JSON.stringify({ h: e.hash, v: encode(e.vector) })).join('\n') + '\n',
        );
    },
  };
}

export interface EmbedAllResult {
  vectors: Float32Array[];
  /** Texts actually sent to the provider (cache misses, de-duplicated). */
  embedded: number;
  cached: number;
}

/**
 * Embed `texts` (documents) through the cache: only misses are sent, in groups of `groupSize` texts (the embedder
 * batches further), and each group is persisted before the next starts.
 */
export async function embedAllWithCache(
  texts: string[],
  embedder: Pick<Embedder, 'embed'>,
  cache: VectorCache,
  opts: { groupSize?: number; onProgress?: (done: number, total: number) => void } = {},
): Promise<EmbedAllResult> {
  const hashes = texts.map(textHash);
  const todo: { hash: string; text: string }[] = [];
  const seen = new Set<string>();
  hashes.forEach((h, i) => {
    if (cache.has(h) || seen.has(h)) return;
    seen.add(h);
    todo.push({ hash: h, text: texts[i] });
  });
  const group = opts.groupSize ?? 960;
  for (let i = 0; i < todo.length; i += group) {
    const slice = todo.slice(i, i + group);
    const vecs = await embedder.embed(
      slice.map((t) => t.text),
      { inputType: 'search_document' },
    );
    cache.put(slice.map((t, j) => ({ hash: t.hash, vector: vecs[j] })));
    opts.onProgress?.(Math.min(i + group, todo.length), todo.length);
  }
  return {
    vectors: hashes.map((h) => cache.get(h)!),
    embedded: todo.length,
    cached: texts.length - todo.length,
  };
}
