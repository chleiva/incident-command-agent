/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import { marshall } from '@aws-sdk/util-dynamodb';
import type { RunEvent } from '@ica/schema';
import sample from '@ica/schema/fixtures/run.sample.events.json' with { type: 'json' };
import { MemoryStore, MemoryTraceStore } from '@ica/store';
import { describe, expect, it } from 'vitest';
import { chunkMessages, createFanoutHandler, MAX_WS_MESSAGE_BYTES, type StreamRecord } from './fanout';

const EVENTS = sample as unknown as RunEvent[];

function record(
  e: RunEvent,
  extra: Record<string, unknown> = {},
  sk = `EVT#${String(e.seq).padStart(8, '0')}`,
): StreamRecord {
  const item = { PK: `RUN#${e.runId}`, SK: sk, type: e.type, seq: e.seq, event: e, ...extra };
  return {
    eventName: 'INSERT',
    dynamodb: {
      Keys: marshall({ PK: item.PK, SK: item.SK }),
      NewImage: marshall(item, { removeUndefinedValues: true }) as Record<string, unknown>,
      SequenceNumber: `seq-${e.runId}-${e.seq}`,
    },
  };
}

function withRun(e: RunEvent, runId: string): RunEvent {
  return { ...e, runId };
}

async function setup(conns: Record<string, string[]>) {
  const store = new MemoryStore();
  for (const [runId, ids] of Object.entries(conns))
    for (const id of ids) await store.putConnection(id, runId);
  const posts: { connectionId: string; msg: { kind: string; runId: string; events: RunEvent[] } }[] = [];
  return { store, posts };
}

describe('fan-out', () => {
  it('groups by run, sorts by seq, de-duplicates and posts to every connection of that run only', async () => {
    const { store, posts } = await setup({ 'run-a': ['c1', 'c2'], 'run-b': ['c3'] });
    const handler = createFanoutHandler({
      store,
      post: async (connectionId, data) => void posts.push({ connectionId, msg: JSON.parse(data) }),
    });
    const a = EVENTS.slice(0, 4).map((e) => withRun(e, 'run-a'));
    const b = EVENTS.slice(4, 6).map((e) => withRun(e, 'run-b'));
    const recs = [
      record(a[2]),
      record(b[1]),
      record(a[0]),
      record(a[3]),
      record(b[0]),
      record(a[1]),
      record(a[1]),
    ];
    const res = await handler({ Records: recs });
    expect(res.batchItemFailures).toEqual([]);
    const forA = posts.filter((p) => p.msg.runId === 'run-a');
    expect(forA.map((p) => p.connectionId).sort()).toEqual(['c1', 'c2']);
    expect(forA[0].msg.kind).toBe('events');
    expect(forA[0].msg.events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    const forB = posts.filter((p) => p.msg.runId === 'run-b');
    expect(forB.map((p) => p.connectionId)).toEqual(['c3']);
    expect(forB[0].msg.events.map((e) => e.seq)).toEqual([5, 6]);
  });

  it('ignores non-EVT rows (defence in depth) and runs without connections', async () => {
    const { store, posts } = await setup({ 'run-a': ['c1'] });
    const handler = createFanoutHandler({
      store,
      post: async (c, d) => void posts.push({ connectionId: c, msg: JSON.parse(d) }),
    });
    const e = withRun(EVENTS[0], 'run-a');
    await handler({
      Records: [record(e, {}, 'SYS#mne#workOrders#wo-1'), record(withRun(EVENTS[1], 'run-z'))],
    });
    expect(posts).toEqual([]);
  });

  it('rehydrates offloaded payloads from the trace store', async () => {
    const { store, posts } = await setup({ 'run-a': ['c1'] });
    const traces = new MemoryTraceStore();
    const full = withRun(EVENTS[14], 'run-a');
    const key = await traces.put('run-a', full.seq, full, { suffix: '.payload' });
    const truncated = { ...full, payload: { _truncated: true, preview: '…' } } as unknown as RunEvent;
    const handler = createFanoutHandler({
      store,
      traces,
      post: async (c, d) => void posts.push({ connectionId: c, msg: JSON.parse(d) }),
    });
    await handler({ Records: [record(truncated, { payloadKey: key })] });
    expect(posts[0].msg.events[0].payload).toEqual(full.payload);
  });

  it('chunks messages to at most 128 KB and preserves order across chunks', () => {
    const big = EVENTS.map(
      (e, i) =>
        ({ ...e, runId: 'run-a', seq: i + 1, payload: { pad: 'x'.repeat(20_000) } }) as unknown as RunEvent,
    );
    const { messages, dropped } = chunkMessages('run-a', big);
    expect(dropped).toEqual([]);
    expect(messages.length).toBeGreaterThan(5);
    const seqs: number[] = [];
    for (const m of messages) {
      expect(Buffer.byteLength(m)).toBeLessThanOrEqual(MAX_WS_MESSAGE_BYTES);
      const parsed = JSON.parse(m);
      expect(parsed.kind).toBe('events');
      seqs.push(...parsed.events.map((e: RunEvent) => e.seq));
    }
    expect(seqs).toEqual(big.map((e) => e.seq));
    const huge = { ...big[0], payload: { pad: 'x'.repeat(MAX_WS_MESSAGE_BYTES) } } as unknown as RunEvent;
    expect(chunkMessages('run-a', [huge, big[1]]).dropped).toEqual([1]);
  });

  it('purges connections on GoneException and keeps delivering to the others', async () => {
    const { store, posts } = await setup({ 'run-a': ['alive', 'gone'] });
    const handler = createFanoutHandler({
      store,
      post: async (connectionId, data) => {
        if (connectionId === 'gone')
          throw Object.assign(new Error('gone'), {
            name: 'GoneException',
            $metadata: { httpStatusCode: 410 },
          });
        posts.push({ connectionId, msg: JSON.parse(data) });
      },
    });
    const res = await handler({ Records: [record(withRun(EVENTS[0], 'run-a'))] });
    expect(res.batchItemFailures).toEqual([]);
    expect(await store.listConnections('run-a')).toEqual(['alive']);
    expect(posts.map((p) => p.connectionId)).toEqual(['alive']);
  });

  it('reports partial batch failures for runs whose delivery failed', async () => {
    const { store } = await setup({ 'run-a': ['c1'], 'run-b': ['c2'] });
    const handler = createFanoutHandler({
      store,
      post: async (connectionId) => {
        if (connectionId === 'c1')
          throw Object.assign(new Error('throttled'), { name: 'LimitExceededException' });
      },
    });
    const res = await handler({
      Records: [
        record(withRun(EVENTS[0], 'run-a')),
        record(withRun(EVENTS[1], 'run-a')),
        record(withRun(EVENTS[0], 'run-b')),
      ],
    });
    expect(res.batchItemFailures.map((f) => f.itemIdentifier).sort()).toEqual(['seq-run-a-1', 'seq-run-a-2']);
    expect(await store.listConnections('run-a')).toEqual(['c1']);
  });
});
