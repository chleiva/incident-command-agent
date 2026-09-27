/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** kb:upload vector sync against a fake S3 Vectors client: batching, idempotency, stale deletion, dim check. */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DeleteVectorsCommand,
  GetIndexCommand,
  ListVectorsCommand,
  PutVectorsCommand,
} from '@aws-sdk/client-s3vectors';
import { vectorsToBytes, type IndexManifest } from '@ica/kb';
import { describe, expect, it } from 'vitest';
import {
  DELETE_BATCH,
  PUT_BATCH,
  assertIndexMatches,
  indexFilesToSync,
  planVectorSync,
  readLocalVectors,
  syncVectors,
  vectorHash,
  type LocalVector,
  type VectorsClientLike,
} from './vectors-sync';

/** In-memory S3 Vectors index with paging, throttling on demand and call counters. */
function fakeIndex(opts: { dimension?: number; throttleFirstPut?: boolean } = {}) {
  const store = new Map<string, { data: number[]; metadata: Record<string, string> }>();
  const calls = { put: 0, del: 0, list: 0, putSizes: [] as number[] };
  let throttle = !!opts.throttleFirstPut;
  const client: VectorsClientLike = {
    async send(cmd) {
      if (cmd instanceof ListVectorsCommand) {
        calls.list++;
        const keys = [...store.keys()].sort();
        const start = Number(cmd.input.nextToken ?? 0);
        const page = keys.slice(start, start + (cmd.input.maxResults ?? 1000));
        return {
          vectors: page.map((key) => ({
            key,
            metadata: cmd.input.returnMetadata ? store.get(key)!.metadata : undefined,
          })),
          nextToken: start + page.length < keys.length ? String(start + page.length) : undefined,
        };
      }
      if (cmd instanceof PutVectorsCommand) {
        if (throttle) {
          throttle = false;
          throw Object.assign(new Error('slow down'), {
            name: 'TooManyRequestsException',
            $metadata: { httpStatusCode: 429 },
          });
        }
        const vs = cmd.input.vectors ?? [];
        expect(vs.length).toBeLessThanOrEqual(500);
        calls.put++;
        calls.putSizes.push(vs.length);
        for (const v of vs)
          store.set(v.key!, {
            data: v.data!.float32 as number[],
            metadata: v.metadata as Record<string, string>,
          });
        return {};
      }
      if (cmd instanceof DeleteVectorsCommand) {
        expect((cmd.input.keys ?? []).length).toBeLessThanOrEqual(500);
        calls.del++;
        for (const k of cmd.input.keys ?? []) store.delete(k);
        return {};
      }
      if (cmd instanceof GetIndexCommand)
        return { index: { dimension: opts.dimension ?? 4, distanceMetric: 'cosine' } };
      throw new Error('unexpected command');
    },
  };
  return { client, store, calls };
}

const local = (n: number, salt = 0): LocalVector[] =>
  Array.from({ length: n }, (_, i) => {
    const data = Float32Array.from([i, salt, 1, 0]);
    const metadata = { collection: 'precedent', jurisdiction: 'US', sourceId: `S${i}`, docId: `d${i}` };
    return { key: `asrs-${i}#1`, data, metadata, hash: vectorHash(data, metadata) };
  });

const noSleep = async () => {};

describe('kb:upload vector sync (S3 Vectors)', () => {
  it('puts in batches of ≤ 500 (we use 200), stores the content hash, then is idempotent', async () => {
    const f = fakeIndex();
    const vecs = local(450);
    const r1 = await syncVectors(f.client, { bucket: 'b', index: 'i', vectors: vecs, sleep: noSleep });
    expect(PUT_BATCH).toBeLessThanOrEqual(500);
    expect(f.calls.putSizes.sort((a, b) => b - a)).toEqual([200, 200, 50]);
    expect(r1.put).toHaveLength(450);
    expect(f.store.get('asrs-7#1')!.metadata.hash).toBe(vecs[7].hash);
    expect(f.store.get('asrs-7#1')!.metadata).not.toHaveProperty('text');
    const puts = f.calls.put;
    const r2 = await syncVectors(f.client, { bucket: 'b', index: 'i', vectors: vecs, sleep: noSleep });
    expect(r2).toMatchObject({ put: [], remove: [], putCalls: 0, deleteCalls: 0 });
    expect(r2.unchanged).toHaveLength(450);
    expect(f.calls.put).toBe(puts);
  });

  it('re-puts only changed vectors and deletes stale keys (batched ≤ 500); --keep-stale keeps them', async () => {
    const f = fakeIndex();
    await syncVectors(f.client, { bucket: 'b', index: 'i', vectors: local(1200), sleep: noSleep });
    const next = [...local(10, 1), ...local(600).slice(10)]; // 10 changed, 600 kept, 600 stale
    const keep = await syncVectors(f.client, {
      bucket: 'b',
      index: 'i',
      vectors: next,
      deleteStale: false,
      sleep: noSleep,
    });
    expect(keep.put).toHaveLength(10);
    expect(f.store.size).toBe(1200);
    const r = await syncVectors(f.client, { bucket: 'b', index: 'i', vectors: next, sleep: noSleep });
    expect(r.put).toHaveLength(0);
    expect(r.remove).toHaveLength(600);
    expect(r.deleteCalls).toBe(Math.ceil(600 / DELETE_BATCH));
    expect(f.store.size).toBe(600);
    expect(f.calls.list).toBeGreaterThanOrEqual(5); // paged ListVectors (1000 per page)
  });

  it('dry run plans without writing; throttled puts are retried', async () => {
    const f = fakeIndex({ throttleFirstPut: true });
    const dry = await syncVectors(f.client, {
      bucket: 'b',
      index: 'i',
      vectors: local(5),
      dryRun: true,
      sleep: noSleep,
    });
    expect(dry.put).toHaveLength(5);
    expect(f.store.size).toBe(0);
    await syncVectors(f.client, { bucket: 'b', index: 'i', vectors: local(5), sleep: noSleep });
    expect(f.store.size).toBe(5);
  });

  it('plans put/remove/unchanged by content hash (a vector without hash is re-put)', () => {
    const plan = planVectorSync(
      [
        { key: 'a', hash: '1' },
        { key: 'b', hash: '2' },
        { key: 'c', hash: '3' },
      ],
      new Map([
        ['a', '1'],
        ['b', 'old'],
        ['c', undefined],
        ['z', '9'],
      ]),
    );
    expect(plan).toEqual({ put: ['b', 'c'], remove: ['z'], unchanged: ['a'] });
  });

  it('reads the build vectors (keys.jsonl + embeddings.f32) and refuses a dimension mismatch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ica-vec-'));
    mkdirSync(join(dir, 'vectors'));
    const vecs = [Float32Array.from([1, 0, 0, 0]), Float32Array.from([0, 1, 0, 0])];
    writeFileSync(join(dir, 'vectors/embeddings.f32'), vectorsToBytes(vecs, 4));
    writeFileSync(
      join(dir, 'vectors/keys.jsonl'),
      ['a#1', 'b#1'].map((key) => JSON.stringify({ key, metadata: { collection: 'mel' } })).join('\n') + '\n',
    );
    writeFileSync(join(dir, 'chunks.jsonl'), '{}\n');
    const manifest = { embeddings: { provider: 'cohere', dim: 4, store: 's3vectors' } } as IndexManifest;
    const read = readLocalVectors(dir + '/', manifest);
    expect(read.map((v) => [v.key, [...v.data]])).toEqual([
      ['a#1', [1, 0, 0, 0]],
      ['b#1', [0, 1, 0, 0]],
    ]);
    expect(indexFilesToSync(dir, 'index/').map((f) => f.key)).toEqual(['index/chunks.jsonl']);
    await expect(
      assertIndexMatches(fakeIndex({ dimension: 1536 }).client, 'b', 'i', manifest),
    ).rejects.toThrow(/dimension 1536 but the build has 4/);
    await expect(
      assertIndexMatches(fakeIndex({ dimension: 4 }).client, 'b', 'i', manifest),
    ).resolves.toBeUndefined();
  });
});
