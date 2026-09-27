/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** Cohere Embed v4 batching / retry / usage and the resumable embedding cache (fake Bedrock, no network). */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COHERE_EMBED_MODEL, cohereEmbedder, isRetryable, type InvokeFn } from './cohere';
import { embeddingProviderFromEnv } from './embed';
import { embedAllWithCache, openVectorCache, textHash } from './embed-cache';

const DIM = 8;
function fakeBedrock(opts: { throttleFirst?: number } = {}) {
  const calls: { modelId: string; body: Record<string, unknown> }[] = [];
  let throttles = opts.throttleFirst ?? 0;
  const invoke: InvokeFn = async (modelId, body) => {
    if (throttles-- > 0)
      throw Object.assign(new Error('Too many requests'), {
        name: 'ThrottlingException',
        $metadata: { httpStatusCode: 429 },
      });
    const b = body as { texts: string[]; output_dimension: number };
    calls.push({ modelId, body: b as unknown as Record<string, unknown> });
    return {
      body: {
        embeddings: {
          float: b.texts.map((t) => Array.from({ length: b.output_dimension }, (_, i) => t.length + i)),
        },
      },
      inputTokens: b.texts.length * 3,
    };
  };
  return { invoke, calls };
}

describe('cohere embedder (Bedrock, EU inference profile)', () => {
  it('batches ≤ 96 texts per call with the document/query input types and records tokens', async () => {
    const fake = fakeBedrock();
    const e = cohereEmbedder({ dim: DIM, invoke: fake.invoke, concurrency: 3 });
    const texts = Array.from({ length: 200 }, (_, i) => `chunk ${i}`);
    const vecs = await e.embed(texts);
    expect(vecs).toHaveLength(200);
    expect(fake.calls.map((c) => (c.body.texts as string[]).length)).toEqual([96, 96, 8]);
    expect(fake.calls[0].modelId).toBe(COHERE_EMBED_MODEL);
    expect(COHERE_EMBED_MODEL).toBe('eu.cohere.embed-v4:0');
    expect(fake.calls[0].body).toMatchObject({
      input_type: 'search_document',
      embedding_types: ['float'],
      output_dimension: DIM,
      truncate: 'RIGHT',
    });
    // Order is preserved across concurrent batches; vectors are L2-normalised.
    const expected = Array.from({ length: DIM }, (_, i) => 'chunk 150'.length + i);
    const norm = Math.hypot(...expected);
    expect(vecs[150][0]).toBeCloseTo(expected[0] / norm, 5);
    expect(e.usage).toMatchObject({ calls: 3, inputTokens: 600, retries: 0 });
    await e.embed(['q'], { inputType: 'search_query' });
    expect(fake.calls.at(-1)!.body.input_type).toBe('search_query');
  });

  it('retries throttling with backoff, and fails fast on non-retryable errors', async () => {
    const fake = fakeBedrock({ throttleFirst: 2 });
    const sleeps: number[] = [];
    const e = cohereEmbedder({ dim: DIM, invoke: fake.invoke, sleep: async (ms) => void sleeps.push(ms) });
    expect(await e.embed(['a'])).toHaveLength(1);
    expect(e.usage?.retries).toBe(2);
    expect(sleeps[1]).toBeGreaterThanOrEqual(sleeps[0]);
    const bad = cohereEmbedder({
      dim: DIM,
      invoke: async () => {
        throw Object.assign(new Error('bad'), {
          name: 'ValidationException',
          $metadata: { httpStatusCode: 400 },
        });
      },
      sleep: async () => {},
    });
    await expect(bad.embed(['a'])).rejects.toThrow('bad');
    expect(isRetryable({ name: 'ValidationException', $metadata: { httpStatusCode: 400 } })).toBe(false);
  });

  it('limits tokens and requests per rolling minute (sliding window)', async () => {
    const { MinuteRateLimiter } = await import('./cohere');
    let t = 0;
    const waits: number[] = [];
    const rl = new MinuteRateLimiter(
      1000,
      2,
      () => t,
      async (ms) => {
        waits.push(ms);
        t += ms;
      },
    );
    await rl.acquire(600);
    await rl.acquire(300); // 900 tokens, 2 requests: fits
    expect(waits).toEqual([]);
    await rl.acquire(10); // 3rd request in the minute: waits for the window
    expect(waits.length).toBeGreaterThan(0);
    expect(t).toBeGreaterThanOrEqual(60_000);
    const big = new MinuteRateLimiter(
      100,
      0,
      () => t,
      async (ms) => void (t += ms),
    );
    await big.acquire(500); // a single oversized batch is let through when the window is empty
  });

  it('rejects a response with the wrong dimension', async () => {
    const e = cohereEmbedder({
      dim: 4,
      invoke: async () => ({ body: { embeddings: { float: [[1, 2, 3]] } } }),
    });
    await expect(e.embed(['x'])).rejects.toThrow(/expected dim 4/);
  });

  it('KB_EMBEDDINGS accepts cohere (bedrock is an alias)', () => {
    expect(embeddingProviderFromEnv({ KB_EMBEDDINGS: 'cohere' })).toBe('cohere');
    expect(embeddingProviderFromEnv({ KB_EMBEDDINGS: 'bedrock' })).toBe('cohere');
    expect(() => embeddingProviderFromEnv({ KB_EMBEDDINGS: 'titan' })).toThrow();
  });
});

describe('resumable embedding cache', () => {
  it('only embeds misses (deduplicated), persists each group, and a rerun pays nothing', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'ica-emb-')), 'cache.jsonl');
    const fake = fakeBedrock();
    const e = cohereEmbedder({ dim: DIM, invoke: fake.invoke });
    const texts = ['a', 'b', 'a', 'c'];
    const r1 = await embedAllWithCache(texts, e, openVectorCache(file), { groupSize: 2 });
    expect(r1).toMatchObject({ embedded: 3, cached: 1 });
    expect(r1.vectors[0]).toEqual(r1.vectors[2]);
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(3);
    const before = fake.calls.length;
    const r2 = await embedAllWithCache([...texts, 'd'], e, openVectorCache(file));
    expect(r2).toMatchObject({ embedded: 1, cached: 4 });
    expect(fake.calls.length).toBe(before + 1);
    expect(r2.vectors[1]).toEqual(r1.vectors[1]);
  });

  it('resumes after an interruption (a torn last line is ignored) and keys by exact text', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'ica-emb-')), 'cache.jsonl');
    const cache = openVectorCache(file);
    cache.put([{ hash: textHash('x'), vector: Float32Array.from([1, 0]) }]);
    const { appendFileSync } = await import('node:fs');
    appendFileSync(file, '{"h":"torn');
    const reopened = openVectorCache(file);
    expect(reopened.size).toBe(1);
    expect([...reopened.get(textHash('x'))!]).toEqual([1, 0]);
    expect(reopened.has(textHash('x '))).toBe(false);
  });
});
