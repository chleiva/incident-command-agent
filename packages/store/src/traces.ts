/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** TraceStore implementations: full prompts/completions and oversized payloads (`traces/{runId}/{seq}{suffix}.json`). */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { TracePutOptions, TraceStore } from '@ica/schema';

const SAFE = /^[A-Za-z0-9._-]+$/;

export function traceKey(runId: string, seq: number | string, suffix = ''): string {
  const name = `${seq}${suffix}`;
  if (!SAFE.test(runId) || !SAFE.test(name)) throw new Error(`unsafe trace key parts: ${runId}/${name}`);
  return `traces/${runId}/${name}.json`;
}

function assertKey(key: string): void {
  if (!/^traces\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\.json$/.test(key) || key.includes('..')) {
    throw new Error(`invalid trace key: ${key}`);
  }
}

/** Local traces under `.local/` (git-ignored). */
export class FsTraceStore implements TraceStore {
  private readonly root: string;
  constructor(root = '.local') {
    this.root = resolve(root);
  }
  async put(runId: string, seq: number | string, body: unknown, opts: TracePutOptions = {}): Promise<string> {
    const key = traceKey(runId, seq, opts.suffix);
    const file = join(this.root, key);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(body));
    return key;
  }
  async get(key: string): Promise<unknown> {
    assertKey(key);
    return JSON.parse(await readFile(join(this.root, key), 'utf8'));
  }
}

/** In-memory traces for tests. */
export class MemoryTraceStore implements TraceStore {
  readonly items = new Map<string, string>();
  async put(runId: string, seq: number | string, body: unknown, opts: TracePutOptions = {}): Promise<string> {
    const key = traceKey(runId, seq, opts.suffix);
    this.items.set(key, JSON.stringify(body));
    return key;
  }
  async get(key: string): Promise<unknown> {
    const v = this.items.get(key);
    if (v === undefined) throw new Error(`trace not found: ${key}`);
    return JSON.parse(v);
  }
}

export interface S3TraceStoreOptions {
  bucket: string;
  client?: S3Client;
  region?: string;
}

/** Traces bucket (DataStack): `s3://{bucket}/traces/{runId}/{seq}.json`. */
export class S3TraceStore implements TraceStore {
  private readonly client: S3Client;
  private readonly bucket: string;
  constructor(opts: S3TraceStoreOptions) {
    this.bucket = opts.bucket;
    this.client = opts.client ?? new S3Client({ region: opts.region });
  }
  async put(runId: string, seq: number | string, body: unknown, opts: TracePutOptions = {}): Promise<string> {
    const key = traceKey(runId, seq, opts.suffix);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: JSON.stringify(body),
        ContentType: 'application/json',
      }),
    );
    return key;
  }
  async get(key: string): Promise<unknown> {
    assertKey(key);
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    const text = await res.Body?.transformToString('utf8');
    if (text === undefined) throw new Error(`empty trace: ${key}`);
    return JSON.parse(text);
  }
}
