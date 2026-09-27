/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** Selective rerank under the per-minute quota: agreement skip, cache, budget skip, throttle back-off. */
import { INDEX_FILES, serialiseIndex, type ChunkRecord, type IndexManifest } from '@ica/kb';
import { describe, expect, it } from 'vitest';
import { indexFromFiles, RerankBudget, type QueryEmbedder, type Reranker, type VectorSearch } from './index';

const chunk = (chunkId: string, docId: string, text: string): ChunkRecord =>
  ({
    chunkId,
    docId,
    sourceId: `SRC ${docId}`,
    url: 'https://example.org',
    title: docId,
    collection: 'precedent',
    jurisdiction: 'US',
    licence: 'public domain',
    header: `Test › ${docId}`,
    text,
  }) as unknown as ChunkRecord;

const CHUNKS = [
  chunk('a#1', 'a', 'towbar shear pin failed during pushback, nose gear inspected'),
  chunk('b#1', 'b', 'catering truck struck the forward service door during turnaround'),
  chunk('c#1', 'c', 'bird strike on climb, engine vibration, air turnback'),
];

function files() {
  const emb: IndexManifest['embeddings'] = {
    provider: 'cohere',
    model: 'eu.cohere.embed-v4:0',
    dim: 4,
    store: 's3vectors',
  };
  const out = serialiseIndex(CHUNKS, { builtAt: '2026-09-27T00:00:00Z', embeddings: emb, sources: [] });
  const enc = new TextEncoder();
  const f: Partial<Record<keyof typeof INDEX_FILES, Uint8Array>> = {};
  for (const [k, name] of Object.entries(INDEX_FILES) as [keyof typeof INDEX_FILES, string][]) {
    const v = out[name];
    if (v !== undefined) f[k] = typeof v === 'string' ? enc.encode(v) : v;
  }
  return f;
}

const embedder: QueryEmbedder = {
  dim: 4,
  model: 'eu.cohere.embed-v4:0',
  embed: async (texts) => texts.map(() => Float32Array.from([1, 0, 0, 0])),
};
/** Dense retrieval returns `order`; BM25 decides its own top from the query text. */
const vectors = (order: string[]): VectorSearch => ({
  kind: 's3vectors',
  query: async () => order.map((key, i) => ({ key, score: 1 - i * 0.1 })),
});
function countingReranker(fail?: Error): Reranker & { calls: number } {
  const r = {
    model: 'fake',
    calls: 0,
    async rerank(_q: string, docs: string[], topN: number) {
      r.calls++;
      if (fail) throw fail;
      return docs.map((_, i) => ({ index: docs.length - 1 - i, score: 0.9 - i * 0.1 })).slice(0, topN);
    },
  };
  return r;
}

describe('selective rerank', () => {
  it('skips rerank when BM25 and vectors agree on the top document', async () => {
    const rr = countingReranker();
    const idx = indexFromFiles(files(), {
      embedder,
      vectorSearch: vectors(['a#1', 'b#1']),
      reranker: rr,
      env: {},
    });
    await idx.search({ query: 'towbar shear pin pushback', k: 2 });
    expect(rr.calls).toBe(0);
    expect(idx.lastTrace()).toMatchObject({ rerank: 'skipped_agreement', mode: 'hybrid' });
  });

  it('reranks when they disagree, then serves the same query from cache', async () => {
    const rr = countingReranker();
    const idx = indexFromFiles(files(), {
      embedder,
      vectorSearch: vectors(['c#1', 'b#1']),
      reranker: rr,
      env: {},
    });
    await idx.search({ query: 'towbar shear pin pushback', k: 2 });
    expect(idx.lastTrace()).toMatchObject({ rerank: 'applied', mode: 'hybrid+rerank' });
    await idx.search({ query: 'towbar shear pin pushback', k: 2 });
    expect(rr.calls).toBe(1);
    expect(idx.lastTrace()).toMatchObject({ rerank: 'cached', mode: 'hybrid+rerank' });
  });

  it('skips instantly (no call, no error) when the per-minute budget is spent', async () => {
    const rr = countingReranker();
    const budget = new RerankBudget(1, () => 0);
    const idx = indexFromFiles(files(), {
      embedder,
      vectorSearch: vectors(['c#1', 'b#1']),
      reranker: rr,
      rerankBudget: budget,
      env: {},
    });
    await idx.search({ query: 'towbar shear pin pushback', k: 2 });
    await idx.search({ query: 'catering truck door', k: 2 });
    expect(rr.calls).toBe(1);
    expect(idx.lastTrace()).toMatchObject({ rerank: 'skipped_budget', mode: 'hybrid', fallbacks: [] });
  });

  it('drains the budget when Bedrock throttles anyway', async () => {
    const throttle = Object.assign(new Error('Too many requests'), { name: 'ThrottlingException' });
    const rr = countingReranker(throttle);
    let t = 0;
    const budget = new RerankBudget(3, () => t);
    const idx = indexFromFiles(files(), {
      embedder,
      vectorSearch: vectors(['c#1', 'b#1']),
      reranker: rr,
      rerankBudget: budget,
      env: {},
    });
    await idx.search({ query: 'towbar shear pin pushback', k: 2 });
    expect(idx.lastTrace()).toMatchObject({ rerank: 'failed', mode: 'hybrid' });
    expect(budget.available()).toBeLessThan(1);
    t = 30_000; // half a minute later: 1.5 tokens back
    expect(budget.available()).toBeGreaterThanOrEqual(1);
  });
});

describe('RerankBudget', () => {
  it('refills continuously up to the per-minute cap; 0 means unlimited', () => {
    let t = 0;
    const b = new RerankBudget(3, () => t);
    expect([b.tryTake(), b.tryTake(), b.tryTake(), b.tryTake()]).toEqual([true, true, true, false]);
    t = 20_000;
    expect(b.tryTake()).toBe(true);
    expect(b.tryTake()).toBe(false);
    t = 10 * 60_000;
    expect(b.available()).toBe(3);
    const unlimited = new RerankBudget(0);
    expect(Array.from({ length: 10 }, () => unlimited.tryTake()).every(Boolean)).toBe(true);
  });
});
