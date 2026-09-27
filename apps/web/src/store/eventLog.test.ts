/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import { foldEvents, type RunEvent } from '@ica/schema/browser';
import { describe, expect, it } from 'vitest';
import { RECORDINGS } from '../mocks/recordings';
import { CHECKPOINT_EVERY, EventLog } from './eventLog';
import { createRunStore } from './runStore';

const events = RECORDINGS[0]!.agent;

/** A long synthetic run (> 5,000 events) made of repeated world ticks on top of the recording. */
function longRun(n: number): RunEvent[] {
  const out: RunEvent[] = [...events];
  const last = events.at(-1)!;
  for (let i = out.length; i < n; i++) {
    const m = last.simMinute + (i - events.length) / 10;
    out.push({
      ...last,
      seq: i + 1,
      type: 'world.tick',
      simMinute: m,
      payload: { simMinute: m },
    } as RunEvent);
  }
  return out;
}

describe('EventLog', () => {
  it('head equals the shared reducer fold, and duplicates are ignored', () => {
    const log = new EventLog();
    log.append(events.slice(0, 100));
    log.append(events.slice(50, 200));
    log.append(events.slice(200));
    expect(log.events).toHaveLength(events.length);
    expect(log.head).toEqual(foldEvents(events));
  });

  it('at(seq) equals folding the prefix, for seqs around checkpoints', () => {
    const log = new EventLog();
    log.append(events);
    for (const seq of [
      1,
      17,
      CHECKPOINT_EVERY - 1,
      CHECKPOINT_EVERY,
      CHECKPOINT_EVERY + 1,
      250,
      events.length - 1,
    ]) {
      expect(log.at(seq)).toEqual(foldEvents(events.slice(0, seq)));
    }
  });

  it('seqAtMinute finds the last event at or before a sim minute', () => {
    const log = new EventLog();
    log.append(events);
    const seq = log.seqAtMinute(20);
    expect(events[seq - 1]!.simMinute).toBeLessThanOrEqual(20);
    expect(events[seq]!.simMinute).toBeGreaterThan(20);
    expect(log.seqAtMinute(-1)).toBe(0);
  });

  it('scrubbing a 5,000-event run stays within a frame budget (checkpointed)', () => {
    const big = longRun(5_200);
    const log = new EventLog();
    log.append(big);
    const t0 = performance.now();
    for (let i = 0; i < 120; i++) log.at(1 + Math.floor((i * 4_999) / 120));
    const perFrame = (performance.now() - t0) / 120;
    expect(perFrame).toBeLessThan(16);
  });
});

describe('run store', () => {
  it('follows the head when live and reconstructs the view at the cursor', () => {
    const store = createRunStore(events[0]!.runId);
    store.getState().append(events);
    expect(store.getState().view.lastSeq).toBe(events.length);
    store.getState().setCursor(40);
    expect(store.getState().view).toEqual(foldEvents(events.slice(0, 40)));
    expect(store.getState().events).toHaveLength(40);
    store.getState().setCursor(null);
    expect(store.getState().cursorSeq).toBeNull();
    store.getState().setCursorAtMinute(10);
    expect(store.getState().view.simMinute).toBeLessThanOrEqual(10);
  });
});
