/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** TraceStore implementations: full prompts/completions and oversized payloads (`traces/{runId}/{seq}{suffix}.json`). */
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type GetObjectCommandOutput,
  type ListObjectsV2CommandOutput,
} from '@aws-sdk/client-s3';
import type { TraceObjectInfo, TracePutOptions, TraceStore } from '@ica/schema';
import { withRetry, type RetryOptions } from './retry';

const SAFE = /^[A-Za-z0-9._-]+$/;

export function traceKey(runId: string, seq: number | string, suffix = ''): string {
  const name = `${seq}${suffix}`;
  if (!SAFE.test(runId) || !SAFE.test(name)) throw new Error(`unsafe trace key parts: ${runId}/${name}`);
  return `traces/${runId}/${name}.json`;
}

/** `traces/{runId}/` for a safe run id (listing). */
export function traceRunPrefix(runId: string): string {
  if (!SAFE.test(runId) || runId.includes('..')) throw new Error(`unsafe trace run id: ${runId}`);
  return `traces/${runId}/`;
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
  async list(runId: string): Promise<TraceObjectInfo[]> {
    const prefix = traceRunPrefix(runId);
    let names: string[];
    try {
      names = await readdir(join(this.root, prefix));
    } catch {
      return [];
    }
    const out: TraceObjectInfo[] = [];
    for (const name of names.filter((n) => n.endsWith('.json')).sort()) {
      const st = await stat(join(this.root, prefix, name));
      if (st.isFile())
        out.push({ key: `${prefix}${name}`, size: st.size, lastModified: st.mtime.toISOString() });
    }
    return out;
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
  async list(runId: string): Promise<TraceObjectInfo[]> {
    const prefix = traceRunPrefix(runId);
    return [...this.items.entries()]
      .filter(([k]) => k.startsWith(prefix))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, v]) => ({ key, size: Buffer.byteLength(v, 'utf8') }));
  }
}

export interface S3TraceStoreOptions {
  bucket: string;
  client?: Pick<S3Client, 'send'>;
  region?: string;
  /** Transient-error retry policy (default: 5 attempts, full jitter, cap 8 s). */
  retry?: RetryOptions;
}

/** Traces bucket (DataStack): `s3://{bucket}/traces/{runId}/{seq}.json`. */
export class S3TraceStore implements TraceStore {
  private readonly s3: Pick<S3Client, 'send'>;
  private readonly bucket: string;
  private readonly retry: RetryOptions;
  constructor(opts: S3TraceStoreOptions) {
    this.bucket = opts.bucket;
    this.s3 = opts.client ?? new S3Client({ region: opts.region });
    this.retry = opts.retry ?? {};
  }
  /** S3 calls retry transient errors (throttling/SlowDown, 5xx, network) with backoff. */
  private readonly client = {
    send: <T>(cmd: unknown): Promise<T> =>
      withRetry(() => this.s3.send(cmd as never) as Promise<T>, this.retry),
  };
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
    const res = await this.client.send<GetObjectCommandOutput>(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    const text = await res.Body?.transformToString('utf8');
    if (text === undefined) throw new Error(`empty trace: ${key}`);
    return JSON.parse(text);
  }
  /** `ListObjectsV2` under `traces/{runId}/` (needs `s3:ListBucket` with an `s3:prefix` of `traces/*`). */
  async list(runId: string): Promise<TraceObjectInfo[]> {
    const prefix = traceRunPrefix(runId);
    const out: TraceObjectInfo[] = [];
    let token: string | undefined;
    do {
      const res = await this.client.send<ListObjectsV2CommandOutput>(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }),
      );
      for (const o of res.Contents ?? []) {
        if (!o.Key) continue;
        out.push({
          key: o.Key,
          ...(o.Size !== undefined ? { size: o.Size } : {}),
          ...(o.LastModified ? { lastModified: o.LastModified.toISOString() } : {}),
        });
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    return out;
  }
}
