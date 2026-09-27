/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import type { RunEvent } from '@ica/schema';
import { MemoryEventBus, MemoryStore } from './index';
import { makeRunMeta, runStoreConformance, tickDraft } from './store.conformance';

runStoreConformance('MemoryStore', () => new MemoryStore());

describe('MemoryStore specifics', () => {
  it('publishes appended events to the bus in seq order, per run', async () => {
    const bus = new MemoryEventBus();
    const store = new MemoryStore({ bus });
    const meta = makeRunMeta();
    await store.createRun(meta);
    const got: RunEvent[][] = [];
    const unsubscribe = bus.subscribe(meta.runId, (evs) => got.push(evs));
    const other: RunEvent[] = [];
    bus.subscribe('someone-else', (evs) => other.push(...evs));
    await store.append(meta.runId, [tickDraft(1), tickDraft(2)]);
    await store.append(meta.runId, [tickDraft(3)]);
    unsubscribe();
    await store.append(meta.runId, [tickDraft(4)]);
    expect(got.map((b) => b.map((e) => e.seq))).toEqual([[1, 2], [3]]);
    expect(other).toEqual([]);
  });

  it('rejects schema-invalid events without committing anything', async () => {
    const store = new MemoryStore();
    const meta = makeRunMeta();
    await store.createRun(meta);
    const bad = { ...tickDraft(1), payload: { simMinute: 'x' } } as unknown as ReturnType<typeof tickDraft>;
    await expect(store.append(meta.runId, [tickDraft(1), bad])).rejects.toThrow(/invalid event/);
    expect((await store.getRun(meta.runId))?.lastSeq).toBe(0);
  });

  it('isolates stored data from caller mutation', async () => {
    const store = new MemoryStore();
    const meta = makeRunMeta();
    await store.createRun(meta);
    const [e] = await store.append(meta.runId, [tickDraft(1)]);
    (e.payload as { simMinute: number }).simMinute = 99;
    const page = await store.listEvents(meta.runId, 0);
    expect((page.events[0].payload as { simMinute: number }).simMinute).toBe(1);
  });

  it('round-trips through snapshot/fromSnapshot (LOCAL_PERSIST)', async () => {
    const store = new MemoryStore();
    const meta = makeRunMeta();
    await store.createRun(meta);
    await store.append(meta.runId, [tickDraft(1)]);
    const restored = MemoryStore.fromSnapshot(store.snapshot());
    expect((await restored.listEvents(meta.runId, 0)).events).toHaveLength(1);
    expect((await restored.append(meta.runId, [tickDraft(2)]))[0].seq).toBe(2);
  });
});
