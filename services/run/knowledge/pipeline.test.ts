/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Hybrid retrieval pipeline with fake backends (no network): BM25 + vector search → RRF → docId collapse → rerank,
 * metadata filters, every fallback path, manifest/model mismatch refusal, S3 Vectors and Rerank request shapes.
 */
import { INDEX_FILES, contextHeader, serialiseIndex, type ChunkRecord, type IndexManifest } from '@ica/kb';
import { describe, expect, it } from 'vitest';
import {
  KnowledgeIndexMismatchError,
  indexFromFiles,
  knowledgeRuntimeConfig,
  type QueryEmbedder,
  type Reranker,
  type VectorSearch,
} from './index';
import { cohereReranker } from './rerank';
import { s3VectorSearch, type VectorQuery } from './vectors';

const chunk = (id: string, over: Partial<ChunkRecord>): ChunkRecord => ({
  chunkId: `${id}#1`,
  docId: id,
  sourceId: id.toUpperCase(),
  url: 'https://example.invalid',
  title: id,
  collection: 'precedent',
  licence: 'test',
  text: 'filler text',
  ...over,
});

const CHUNKS: ChunkRecord[] = [
  chunk('asrs-1', { text: 'The towbar shear pin failed during pushback from the gate.', jurisdiction: 'US' }),
  {
    ...chunk('asrs-1', {
      text: 'Second part: the tug driver stopped; towbar shear pin replaced.',
      jurisdiction: 'US',
    }),
    chunkId: 'asrs-1#2',
  },
  chunk('asrs-2', { text: 'Catering truck struck the forward door while on stand.', jurisdiction: 'US' }),
  chunk('aaib-3', {
    text: 'Tug and aircraft collided during push back; tow bar damaged.',
    jurisdiction: 'UK',
  }),
  chunk('mmel-49-10-01', {
    collection: 'mel',
    text: 'C 1 0 (O) Except for ETOPS, may be inoperative.',
    header: contextHeader({
      source: 'FAA MMEL A-320',
      path: ['49-10-01 APU System'],
      extra: ['MEL item 49-10-01 APU System'],
    }),
    jurisdiction: 'US',
  }),
  chunk('airbus-x', { collection: 'procedure', text: 'Pushback procedures and towbar checks.' }),
];

const EMB: IndexManifest['embeddings'] = {
  provider: 'cohere',
  model: 'eu.cohere.embed-v4:0',
  dim: 4,
  store: 's3vectors',
};

function files(chunks = CHUNKS, embeddings = EMB) {
  const out = serialiseIndex(chunks, { builtAt: '2026-09-27T00:00:00Z', embeddings, sources: [] });
  const enc = new TextEncoder();
  const f: Partial<Record<keyof typeof INDEX_FILES, Uint8Array>> = {};
  for (const [k, name] of Object.entries(INDEX_FILES) as [keyof typeof INDEX_FILES, string][]) {
    const v = out[name];
    if (v !== undefined) f[k] = typeof v === 'string' ? enc.encode(v) : v;
  }
  return f;
}

function fakeEmbedder(): QueryEmbedder & { calls: { texts: string[]; inputType?: string }[] } {
  const calls: { texts: string[]; inputType?: string }[] = [];
  return {
    calls,
    dim: 4,
    model: 'eu.cohere.embed-v4:0',
    async embed(texts, opts) {
      calls.push({ texts, inputType: opts?.inputType });
      return texts.map(() => Float32Array.from([1, 0, 0, 0]));
    },
  };
}

function fakeVectors(keys: string[]): VectorSearch & { queries: VectorQuery[] } {
  const queries: VectorQuery[] = [];
  return {
    kind: 's3vectors',
    queries,
    async query(_v, q) {
      queries.push(q);
      return keys.map((key, i) => ({ key, score: 1 - i * 0.1 }));
    },
  };
}

const reverseReranker = (): Reranker & { calls: { query: string; docs: string[]; topN: number }[] } => {
  const calls: { query: string; docs: string[]; topN: number }[] = [];
  return {
    model: 'fake-rerank',
    calls,
    async rerank(query, docs, topN) {
      calls.push({ query, docs, topN });
      return docs.map((_, i) => ({ index: docs.length - 1 - i, score: 0.9 - i * 0.1 })).slice(0, topN);
    },
  };
};

const ENV = {};

describe('hybrid retrieval pipeline', () => {
  it('fuses BM25 and vector ranks (RRF), passes the metadata filter, and drops keys outside the filter', async () => {
    const vs = fakeVectors(['asrs-2#1', 'aaib-3#1', 'mmel-49-10-01#1']);
    const idx = indexFromFiles(files(), {
      embedder: fakeEmbedder(),
      vectorSearch: vs,
      reranker: null,
      env: ENV,
    });
    const hits = await idx.search({
      query: 'towbar shear pin',
      collections: ['precedent'],
      jurisdiction: 'US',
      k: 5,
    });
    expect(vs.queries[0]).toMatchObject({ topK: 50, collections: ['precedent'], jurisdiction: 'US' });
    const ids = hits.map((h) => h.chunkId);
    expect(ids[0]).toBe('asrs-1#1'); // strong BM25 match
    expect(ids).toContain('asrs-2#1'); // vector-only hit is fused in
    expect(ids).not.toContain('aaib-3#1'); // UK: outside the jurisdiction filter
    expect(ids).not.toContain('mmel-49-10-01#1'); // other collection
    expect(idx.lastTrace()).toMatchObject({ mode: 'hybrid', fallbacks: [] });
  });

  it('collapses several chunks of one document (docId) to the best-ranked one', async () => {
    const idx = indexFromFiles(files(), { embeddings: 'none', env: ENV });
    const hits = await idx.search({ query: 'towbar shear pin', collections: ['precedent'], k: 5 });
    expect(hits.filter((h) => h.docId === 'asrs-1')).toHaveLength(1);
    expect(hits[0]).toMatchObject({ chunkId: 'asrs-1#1', docId: 'asrs-1' });
  });

  it('reranks the fused, collapsed candidates (header + text) and returns k in rerank order', async () => {
    const rr = reverseReranker();
    const idx = indexFromFiles(files(), {
      embedder: fakeEmbedder(),
      vectorSearch: fakeVectors(['airbus-x#1', 'asrs-2#1']),
      reranker: rr,
      env: ENV,
    });
    const hits = await idx.search({ query: 'towbar pushback', k: 2 });
    const pool = rr.calls[0].docs;
    expect(rr.calls[0]).toMatchObject({ query: 'towbar pushback', topN: 2 });
    expect(pool.length).toBeGreaterThan(2);
    expect(hits).toHaveLength(2);
    expect(hits[0].rerankScore).toBeCloseTo(0.9);
    // Reverse reranker: the last candidate of the pool comes first.
    expect(pool[pool.length - 1]).toContain(hits[0].text);
    expect(idx.lastTrace()?.mode).toBe('hybrid+rerank');
    const mel = await idx.search({ query: '49-10-01', collections: ['mel'], k: 1 });
    expect(mel[0].header).toContain('MEL item 49-10-01');
  });

  it('caches query embeddings (search_query input type) per container', async () => {
    const e = fakeEmbedder();
    const idx = indexFromFiles(files(), {
      embedder: e,
      vectorSearch: fakeVectors([]),
      reranker: null,
      env: ENV,
    });
    await idx.search({ query: 'APU inoperative' });
    await idx.search({ query: 'APU inoperative' });
    expect(e.calls).toHaveLength(1);
    expect(e.calls[0]).toEqual({ texts: ['APU inoperative'], inputType: 'search_query' });
  });
});

describe('graceful degradation (never fails a run)', () => {
  it('embedding error → BM25 only', async () => {
    const idx = indexFromFiles(files(), {
      embedder: { dim: 4, embed: async () => Promise.reject(new Error('AccessDenied')) },
      vectorSearch: fakeVectors(['asrs-2#1']),
      reranker: null,
      env: ENV,
    });
    const hits = await idx.search({ query: 'towbar shear pin', k: 3 });
    expect(hits[0].chunkId).toBe('asrs-1#1');
    expect(hits.map((h) => h.chunkId)).not.toContain('asrs-2#1');
    expect(idx.lastTrace()).toMatchObject({ mode: 'bm25', fallbacks: [{ stage: 'embed' }] });
  });

  it('vector-store timeout → BM25 only', async () => {
    const idx = indexFromFiles(files(), {
      embedder: fakeEmbedder(),
      vectorSearch: { kind: 's3vectors', query: () => new Promise(() => {}) },
      reranker: null,
      env: { KB_VECTOR_TIMEOUT_MS: '20' },
    });
    const hits = await idx.search({ query: 'towbar shear pin', k: 3 });
    expect(hits[0].chunkId).toBe('asrs-1#1');
    expect(idx.lastTrace()?.fallbacks).toEqual([{ stage: 'vector', error: 'Error: timeout after 20 ms' }]);
  });

  it('rerank error or timeout → fused order without rerank', async () => {
    const failing: Reranker = {
      model: 'x',
      rerank: async () => Promise.reject(new Error('ThrottlingException')),
    };
    const opts = { embedder: fakeEmbedder(), vectorSearch: fakeVectors(['asrs-2#1']), env: ENV };
    const plain = await indexFromFiles(files(), { ...opts, reranker: null }).search({
      query: 'towbar',
      k: 3,
    });
    const idx = indexFromFiles(files(), { ...opts, reranker: failing });
    const degraded = await idx.search({ query: 'towbar', k: 3 });
    expect(degraded.map((h) => h.chunkId)).toEqual(plain.map((h) => h.chunkId));
    expect(degraded.every((h) => h.rerankScore === undefined)).toBe(true);
    expect(idx.lastTrace()).toMatchObject({ mode: 'hybrid', fallbacks: [{ stage: 'rerank' }] });
    const slow = indexFromFiles(files(), {
      ...opts,
      reranker: { model: 'x', rerank: () => new Promise(() => {}) },
      env: { KB_RERANK_TIMEOUT_MS: '20' },
    });
    expect((await slow.search({ query: 'towbar', k: 3 })).map((h) => h.chunkId)).toEqual(
      plain.map((h) => h.chunkId),
    );
  });

  it('s3vectors configured but no bucket/index → BM25 only (logged), no throw', async () => {
    const idx = indexFromFiles(files(), { env: {} });
    expect(idx.mode()).toBe('bm25');
    expect((await idx.search({ query: 'towbar shear pin', k: 1 }))[0].chunkId).toBe('asrs-1#1');
  });
});

describe('configuration and manifest validation', () => {
  it('refuses an index built with another embedding model or dimension', () => {
    expect(() =>
      indexFromFiles(files(), {
        env: { KB_EMBED_MODEL: 'cohere.embed-english-v3', KB_VECTOR_BUCKET: 'b', KB_VECTOR_INDEX: 'i' },
      }),
    ).toThrow(KnowledgeIndexMismatchError);
    expect(() => indexFromFiles(files(), { env: { KB_EMBED_DIMS: '1024' } })).toThrow(
      /dims 4 ≠ KB_EMBED_DIMS 1024/,
    );
    expect(() =>
      indexFromFiles(files(), {
        embedder: { dim: 384, embed: async () => [] },
        vectorSearch: fakeVectors([]),
      }),
    ).toThrow(/query embedder 384/);
    const local = files(CHUNKS, {
      provider: 'local',
      model: 'Xenova/all-MiniLM-L6-v2',
      dim: 384,
      store: 'memory',
    });
    expect(() => indexFromFiles(local, { env: { KB_EMBED_MODEL: 'eu.cohere.embed-v4:0' } })).toThrow(
      /built with local:Xenova\/all-MiniLM-L6-v2/,
    );
    // BM25-only runs never validate the embedder.
    expect(() =>
      indexFromFiles(local, { env: { KB_EMBEDDINGS: 'none', KB_EMBED_MODEL: 'x' } }),
    ).not.toThrow();
  });

  it('resolves backends from env + manifest (rerank on with s3vectors, off otherwise or on request)', () => {
    const m = { embeddings: EMB } as IndexManifest;
    expect(knowledgeRuntimeConfig({ KB_VECTOR_BUCKET: 'b', KB_VECTOR_INDEX: 'i' }, m, false)).toMatchObject({
      store: 's3vectors',
      bucket: 'b',
      index: 'i',
      rerank: true,
      rerankModel: 'cohere.rerank-v3-5:0',
      rerankRegion: 'eu-central-1',
      timeouts: { embedMs: 1500, vectorMs: 1500, rerankMs: 2000 },
    });
    expect(knowledgeRuntimeConfig({ KB_RERANK: 'off' }, m, false).rerank).toBe(false);
    expect(knowledgeRuntimeConfig({ KB_EMBEDDINGS: 'none' }, m, false).store).toBe('none');
    expect(knowledgeRuntimeConfig({ KB_VECTOR_STORE: 'memory' }, m, false)).toMatchObject({
      store: 'memory',
      rerank: false,
    });
    const local = { embeddings: { provider: 'local', dim: 384 } } as IndexManifest;
    expect(knowledgeRuntimeConfig({}, local, true)).toMatchObject({ store: 'memory', rerank: false });
  });
});

describe('AWS request shapes (fake clients)', () => {
  it('S3 Vectors QueryVectors: topK, float32 query, metadata filter; distance → similarity', async () => {
    const sent: Record<string, unknown>[] = [];
    const vs = s3VectorSearch({
      bucket: 'vb',
      index: 'vi',
      client: {
        send: async (cmd) => {
          sent.push(cmd.input as unknown as Record<string, unknown>);
          return { vectors: [{ key: 'asrs-1#1', distance: 0.25 }, { key: undefined }] };
        },
      },
    });
    const hits = await vs.query(Float32Array.from([0.5, 0.5]), {
      topK: 50,
      collections: ['precedent'],
      jurisdiction: 'UK',
    });
    expect(sent[0]).toMatchObject({
      vectorBucketName: 'vb',
      indexName: 'vi',
      topK: 50,
      queryVector: { float32: [0.5, 0.5] },
      returnMetadata: false,
      filter: { $and: [{ collection: { $eq: 'precedent' } }, { jurisdiction: { $in: ['UK', 'ANY'] } }] },
    });
    expect(hits).toEqual([{ key: 'asrs-1#1', score: 0.75 }]);
  });

  it('Cohere Rerank 3.5 on Bedrock: {query, documents, top_n, api_version: 2}', async () => {
    const calls: { modelId: string; body: unknown }[] = [];
    const rr = cohereReranker({
      invoke: async (modelId, body) => {
        calls.push({ modelId, body });
        return {
          body: {
            results: [
              { index: 1, relevance_score: 0.62 },
              { index: 0, relevance_score: 0.03 },
              { index: 7, relevance_score: 0.5 },
            ],
          },
        };
      },
    });
    const res = await rr.rerank('towbar shear pin', ['APU inop', 'towbar pin sheared'], 5);
    expect(calls[0]).toEqual({
      modelId: 'cohere.rerank-v3-5:0',
      body: {
        query: 'towbar shear pin',
        documents: ['APU inop', 'towbar pin sheared'],
        top_n: 2,
        api_version: 2,
      },
    });
    expect(res).toEqual([
      { index: 1, score: 0.62 },
      { index: 0, score: 0.03 },
    ]);
  });
});

describe('retrieval sanity eval scoring', () => {
  it('computes hit@3 and MRR from the rank of the first relevant document', async () => {
    const { score, SANITY_CASES } = await import('./retrieval-sanity');
    expect(SANITY_CASES.length).toBeGreaterThanOrEqual(12);
    const cases = [
      { query: 'a', docPrefixes: ['x'] },
      { query: 'b', headers: ['Multiple pushback'] },
      { query: 'c', docPrefixes: ['z'] },
    ];
    const r = score(cases, [
      [{ chunkId: 'y#1' }, { chunkId: 'x#1', docId: 'x' }],
      [{ chunkId: 'q#1', header: 'CAP 642 › Multiple pushback procedures' }],
      [{ chunkId: 'y#1' }],
    ]);
    expect(r.ranks).toEqual([2, 1, null]);
    expect(r.hitAtK).toBeCloseTo(2 / 3);
    expect(r.mrr).toBeCloseTo((1 / 2 + 1) / 3);
  });
});
