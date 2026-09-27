/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Idempotent sync of the built vectors (`data/index/vectors/`) into the Amazon S3 Vectors index (kb:upload).
 *
 * Each vector carries a non-filterable `hash` metadata key (SHA-1 of its float32 data + filterable metadata), so a
 * rerun only puts new or changed vectors and deletes keys that are no longer in the build. Designed around the S3
 * Vectors limits: PutVectors ≤ 500 vectors and ≤ 20 MiB per call (we send 200 × 1536 floats ≈ 3 MB of JSON),
 * DeleteVectors ≤ 500 keys, ListVectors ≤ 1,000 per page, ≤ 2,500 vectors/s written per index (2 calls in flight,
 * backoff on throttling).
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DeleteVectorsCommand,
  GetIndexCommand,
  ListVectorsCommand,
  PutVectorsCommand,
  type PutInputVector,
} from '@aws-sdk/client-s3vectors';
import { VECTOR_FILES, mapLimit, vectorsFromBytes, withRetry, type IndexManifest } from '@ica/kb';
import { listLocalFiles } from './lib';

export const PUT_BATCH = 200;
export const DELETE_BATCH = 500;
export const LIST_PAGE = 1000;
/** Non-filterable metadata key holding the content hash (declared on the index in DataStack). */
export const HASH_KEY = 'hash';

export interface LocalVector {
  key: string;
  data: Float32Array;
  metadata: Record<string, string>;
  hash: string;
}

type Cmd = ListVectorsCommand | PutVectorsCommand | DeleteVectorsCommand | GetIndexCommand;
/** Minimal S3 Vectors client seam (tests pass a fake). */
export interface VectorsClientLike {
  send(cmd: Cmd): Promise<unknown>;
}

export function vectorHash(data: Float32Array, metadata: Record<string, string>): string {
  return createHash('sha1')
    .update(Buffer.from(data.buffer, data.byteOffset, data.byteLength))
    .update(JSON.stringify(Object.entries(metadata).sort(([a], [b]) => a.localeCompare(b))))
    .digest('hex');
}

/** Read `vectors/embeddings.f32` + `vectors/keys.jsonl` of a cohere build (in chunk order). */
export function readLocalVectors(indexDir: string, manifest: IndexManifest): LocalVector[] {
  const dim = manifest.embeddings.dim ?? 0;
  const dataPath = join(indexDir, VECTOR_FILES.data);
  const keysPath = join(indexDir, VECTOR_FILES.keys);
  if (!dim || !existsSync(dataPath) || !existsSync(keysPath))
    throw new Error(`no vectors in ${indexDir}${VECTOR_FILES.dir}/ (build with KB_EMBEDDINGS=cohere)`);
  const vecs = vectorsFromBytes(new Uint8Array(readFileSync(dataPath)), dim);
  const keys = readFileSync(keysPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { key: string; metadata: Record<string, string> });
  if (keys.length !== vecs.length)
    throw new Error(`vectors/ is inconsistent: ${keys.length} keys but ${vecs.length} vectors`);
  return keys.map((k, i) => ({ ...k, data: vecs[i], hash: vectorHash(vecs[i], k.metadata) }));
}

/** Remote keys → stored content hash (undefined when a vector has no hash). */
export async function listRemoteVectors(
  client: VectorsClientLike,
  bucket: string,
  index: string,
): Promise<Map<string, string | undefined>> {
  const out = new Map<string, string | undefined>();
  let nextToken: string | undefined;
  do {
    const res = (await client.send(
      new ListVectorsCommand({
        vectorBucketName: bucket,
        indexName: index,
        maxResults: LIST_PAGE,
        returnMetadata: true,
        nextToken,
      }),
    )) as { vectors?: { key?: string; metadata?: Record<string, unknown> }[]; nextToken?: string };
    for (const v of res.vectors ?? [])
      if (v.key)
        out.set(
          v.key,
          typeof v.metadata?.[HASH_KEY] === 'string' ? (v.metadata[HASH_KEY] as string) : undefined,
        );
    nextToken = res.nextToken;
  } while (nextToken);
  return out;
}

export interface VectorPlan {
  put: string[];
  remove: string[];
  unchanged: string[];
}

export function planVectorSync(
  local: Pick<LocalVector, 'key' | 'hash'>[],
  remote: Map<string, string | undefined>,
): VectorPlan {
  const localKeys = new Set(local.map((l) => l.key));
  const put: string[] = [];
  const unchanged: string[] = [];
  for (const l of local) (remote.get(l.key) === l.hash ? unchanged : put).push(l.key);
  const remove = [...remote.keys()].filter((k) => !localKeys.has(k)).sort();
  return { put, remove, unchanged };
}

export interface SyncVectorsOptions {
  bucket: string;
  index: string;
  vectors: LocalVector[];
  dryRun?: boolean;
  /** Delete remote keys that are not in the build (default true). */
  deleteStale?: boolean;
  concurrency?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
}

export interface SyncVectorsResult extends VectorPlan {
  putCalls: number;
  deleteCalls: number;
}

/** Plan, then PutVectors (new/changed) and DeleteVectors (stale) in batches, with backoff on throttling. */
export async function syncVectors(
  client: VectorsClientLike,
  o: SyncVectorsOptions,
): Promise<SyncVectorsResult> {
  const log = o.log ?? (() => {});
  const plan = planVectorSync(o.vectors, await listRemoteVectors(client, o.bucket, o.index));
  log(
    `  vectors: ${plan.put.length} to put, ${plan.unchanged.length} unchanged, ${plan.remove.length} stale`,
  );
  const result: SyncVectorsResult = { ...plan, putCalls: 0, deleteCalls: 0 };
  if (o.dryRun) return result;
  const retry = {
    maxAttempts: 8,
    backoffMs: 500,
    sleep: o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms))),
  };
  const byKey = new Map(o.vectors.map((v) => [v.key, v]));
  const putBatches: string[][] = [];
  for (let i = 0; i < plan.put.length; i += PUT_BATCH) putBatches.push(plan.put.slice(i, i + PUT_BATCH));
  let done = 0;
  await mapLimit(putBatches, o.concurrency ?? 2, async (keys) => {
    const vectors: PutInputVector[] = keys.map((k) => {
      const v = byKey.get(k)!;
      return {
        key: k,
        data: { float32: Array.from(v.data) },
        metadata: { ...v.metadata, [HASH_KEY]: v.hash },
      };
    });
    await withRetry(
      () => client.send(new PutVectorsCommand({ vectorBucketName: o.bucket, indexName: o.index, vectors })),
      retry,
    );
    result.putCalls++;
    done += keys.length;
    log(`  put ${done}/${plan.put.length}`);
  });
  if (o.deleteStale !== false)
    for (let i = 0; i < plan.remove.length; i += DELETE_BATCH) {
      const keys = plan.remove.slice(i, i + DELETE_BATCH);
      await withRetry(
        () => client.send(new DeleteVectorsCommand({ vectorBucketName: o.bucket, indexName: o.index, keys })),
        retry,
      );
      result.deleteCalls++;
    }
  return result;
}

/** Refuse to upload vectors whose dimension or metric does not match the S3 Vectors index. */
export async function assertIndexMatches(
  client: VectorsClientLike,
  bucket: string,
  index: string,
  manifest: IndexManifest,
): Promise<void> {
  const res = (await client.send(new GetIndexCommand({ vectorBucketName: bucket, indexName: index }))) as {
    index?: { dimension?: number; distanceMetric?: string; dataType?: string };
  };
  const dim = res.index?.dimension;
  if (dim !== undefined && dim !== manifest.embeddings.dim)
    throw new Error(
      `S3 Vectors index ${index} has dimension ${dim} but the build has ${manifest.embeddings.dim}: refusing to upload`,
    );
}

/** Local files for the knowledge bucket: the Lambda-loaded index files only (vectors/ goes to S3 Vectors). */
export function indexFilesToSync(dir: string, prefix: string) {
  return listLocalFiles(dir, prefix).filter((f) => !f.key.slice(prefix.length).includes('/'));
}
