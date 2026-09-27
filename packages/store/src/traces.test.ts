/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ListObjectsV2Command, type S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { FsTraceStore, MemoryTraceStore, S3TraceStore, traceRunPrefix } from './index';

describe('TraceStore.list (audit logs)', () => {
  it('MemoryTraceStore lists one run only, in key order, with sizes', async () => {
    const t = new MemoryTraceStore();
    await t.put('r1', 'ar-orch-1-i001', { a: 1 });
    await t.put('r1', 'ar-orch-1-i000', { a: 1 });
    await t.put('r10', 'ar-orch-1-i000', { b: 2 });
    const items = await t.list('r1');
    expect(items.map((i) => i.key)).toEqual([
      'traces/r1/ar-orch-1-i000.json',
      'traces/r1/ar-orch-1-i001.json',
    ]);
    expect(items[0]!.size).toBe(7);
  });

  it('FsTraceStore lists files under traces/{runId}/ and tolerates a missing run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ica-traces-'));
    try {
      const t = new FsTraceStore(root);
      await t.put('r1', 'ar-mx-1-i000', { hello: 'world' });
      await t.put('r1', 7, { e: 1 }, { suffix: '.payload' });
      const items = await t.list('r1');
      expect(items.map((i) => i.key)).toEqual(['traces/r1/7.payload.json', 'traces/r1/ar-mx-1-i000.json']);
      expect(items[1]!.size).toBeGreaterThan(0);
      expect(items[1]!.lastModified).toMatch(/^\d{4}-/);
      expect(await t.list('nope')).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('S3TraceStore pages ListObjectsV2 under the run prefix', async () => {
    const sent: ListObjectsV2Command[] = [];
    const client = {
      send: async (cmd: ListObjectsV2Command) => {
        sent.push(cmd);
        return cmd.input.ContinuationToken
          ? { Contents: [{ Key: 'traces/r1/b.json', Size: 2 }], IsTruncated: false }
          : {
              Contents: [
                { Key: 'traces/r1/a.json', Size: 1, LastModified: new Date('2026-09-27T10:00:00Z') },
              ],
              IsTruncated: true,
              NextContinuationToken: 'next',
            };
      },
    } as unknown as S3Client;
    const t = new S3TraceStore({ bucket: 'b', client });
    expect(await t.list('r1')).toEqual([
      { key: 'traces/r1/a.json', size: 1, lastModified: '2026-09-27T10:00:00.000Z' },
      { key: 'traces/r1/b.json', size: 2 },
    ]);
    expect(sent.map((c) => c.input.Prefix)).toEqual(['traces/r1/', 'traces/r1/']);
    expect(sent[0]).toBeInstanceOf(ListObjectsV2Command);
  });

  it('rejects unsafe run ids', () => {
    expect(() => traceRunPrefix('../x')).toThrow();
    expect(() => traceRunPrefix('a/b')).toThrow();
  });
});
