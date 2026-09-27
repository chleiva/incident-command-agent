/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * `npm run kb:upload [-- --delete] [--dry-run]`: syncs `data/index/` to `s3://<KnowledgeBucket>/index/` (where the
 * Run and author Lambdas load it: `loadKnowledgeIndex({source:'s3', path:'s3://<bucket>/index'})`) and, if present,
 * `data/models/` (local embedding model files) to `models/`. Unchanged files (same MD5/ETag) are skipped.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DeleteObjectsCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
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

async function sync(s3: S3Client, bucket: string, dir: string, prefix: string, del: boolean, dry: boolean) {
  const local = listLocalFiles(dir, prefix);
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
  const indexDir = join(REPO_ROOT, 'data/index');
  if (!existsSync(indexDir)) fail('data/index/ not found: run `npm run kb:build` first');
  const region = awsRegion();
  const stack = stackName('Data');
  const bucket = requireOutput(await getStackOutputs(stack, { region }), 'KnowledgeBucketName', stack);
  const s3 = new S3Client({ region });
  const del = process.argv.includes('--delete');
  const dry = process.argv.includes('--dry-run');
  console.log(`Syncing the knowledge index to s3://${bucket}/`);
  await sync(s3, bucket, indexDir, 'index/', del, dry);
  const models = join(REPO_ROOT, 'data/models');
  if (existsSync(models)) await sync(s3, bucket, models, 'models/', del, dry);
  console.log('✔ Knowledge index uploaded (new Run Lambda containers load it at cold start).');
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
