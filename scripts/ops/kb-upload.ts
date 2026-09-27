/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * `npm run kb:upload [-- --dry-run] [--keep-stale] [--delete]`
 *
 * 1. Vectors (index built with `KB_EMBEDDINGS=cohere`): `data/index/vectors/` → the Amazon S3 Vectors index from the
 *    DataStack outputs (`VectorBucketName`, `VectorIndexName`), idempotently: only new/changed vectors are put (content
 *    hash in metadata), stale keys are deleted (unless `--keep-stale`). The index dimension is checked first.
 * 2. Files: the Lambda-loaded index files in `data/index/` (not `vectors/`) → `s3://<KnowledgeBucket>/index/` (where
 *    the Run and author Lambdas load it) and, if present, `data/models/` → `models/`. Unchanged files (same MD5/ETag)
 *    are skipped; `--delete` removes stale objects.
 *
 * Refuses an index built with `local`/`openai` embeddings: the Lambdas query with Cohere Embed v4 and would reject it
 * (a BM25-only index, `KB_EMBEDDINGS=none`, is accepted with a warning).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DeleteObjectsCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { S3VectorsClient } from '@aws-sdk/client-s3vectors';
import type { IndexManifest } from '@ica/kb';
import {
  REPO_ROOT,
  awsRegion,
  contentTypeFor,
  fail,
  getStackOutputs,
  listLocalFiles,
  loadDotEnv,
  planSync,
  requireOutput,
  stackName,
} from './lib';
import {
  assertIndexMatches,
  indexFilesToSync,
  readLocalVectors,
  syncVectors,
  type VectorsClientLike,
} from './vectors-sync';

async function listRemote(s3: S3Client, bucket: string, prefix: string) {
  const out: { key: string; etag?: string }[] = [];
  let token: string | undefined;
  do {
    const res = await s3.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
    );
    for (const o of res.Contents ?? []) if (o.Key) out.push({ key: o.Key, etag: o.ETag });
    token = res.NextContinuationToken;
  } while (token);
  return out;
}

async function sync(
  s3: S3Client,
  bucket: string,
  local: ReturnType<typeof listLocalFiles>,
  prefix: string,
  del: boolean,
  dry: boolean,
) {
  const plan = planSync(local, await listRemote(s3, bucket, prefix));
  const byKey = new Map(local.map((l) => [l.key, l]));
  console.log(
    `  ${prefix}: ${plan.upload.length} to upload, ${plan.unchanged.length} unchanged, ${plan.remove.length} stale`,
  );
  if (dry) return;
  for (const key of plan.upload) {
    const f = byKey.get(key)!;
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: readFileSync(f.path),
        ContentType: contentTypeFor(key),
      }),
    );
  }
  if (del && plan.remove.length) {
    for (let i = 0; i < plan.remove.length; i += 1000) {
      const Objects = plan.remove.slice(i, i + 1000).map((Key) => ({ Key }));
      await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects } }));
    }
    console.log(`  deleted ${plan.remove.length} stale objects`);
  }
}

async function main() {
  loadDotEnv();
  const indexDir = join(REPO_ROOT, 'data/index/');
  if (!existsSync(join(indexDir, 'manifest.json')))
    fail('data/index/ not found: run `npm run kb:build` first');
  const manifest = JSON.parse(readFileSync(join(indexDir, 'manifest.json'), 'utf8')) as IndexManifest;
  const e = manifest.embeddings;
  if (e.provider === 'local' || e.provider === 'openai')
    fail(
      `data/index/ was built with KB_EMBEDDINGS=${e.provider}; the Lambdas query Cohere Embed v4 (S3 Vectors). ` +
        'Rebuild with `KB_EMBEDDINGS=cohere npm run kb:build` (or KB_EMBEDDINGS=none for BM25 only).',
    );
  const region = awsRegion();
  const stack = stackName('Data');
  const outputs = await getStackOutputs(stack, { region });
  const bucket = requireOutput(outputs, 'KnowledgeBucketName', stack);
  const dry = process.argv.includes('--dry-run');

  if (e.store === 's3vectors') {
    const vectorBucket = requireOutput(outputs, 'VectorBucketName', stack);
    const vectorIndex = requireOutput(outputs, 'VectorIndexName', stack);
    const client = new S3VectorsClient({ region }) as unknown as VectorsClientLike;
    await assertIndexMatches(client, vectorBucket, vectorIndex, manifest);
    const vectors = readLocalVectors(indexDir, manifest);
    console.log(
      `Syncing ${vectors.length} vectors (${e.model}, ${e.dim} dims) to ${vectorBucket}/${vectorIndex}`,
    );
    const res = await syncVectors(client, {
      bucket: vectorBucket,
      index: vectorIndex,
      vectors,
      dryRun: dry,
      deleteStale: !process.argv.includes('--keep-stale'),
      log: (m) => console.log(m),
    });
    console.log(
      `  vectors: put ${res.put.length} (${res.putCalls} calls), unchanged ${res.unchanged.length}, ` +
        `deleted ${dry ? 0 : res.remove.length}`,
    );
  } else console.warn('! BM25-only index (no vectors): the Lambdas will search BM25 only.');

  const s3 = new S3Client({ region });
  console.log(`Syncing the knowledge index files to s3://${bucket}/index/`);
  await sync(
    s3,
    bucket,
    indexFilesToSync(indexDir, 'index/'),
    'index/',
    process.argv.includes('--delete'),
    dry,
  );
  const models = join(REPO_ROOT, 'data/models');
  if (existsSync(models))
    await sync(
      s3,
      bucket,
      listLocalFiles(models, 'models/'),
      'models/',
      process.argv.includes('--delete'),
      dry,
    );
  console.log('✔ Knowledge index uploaded (new Run Lambda containers load it at cold start).');
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
