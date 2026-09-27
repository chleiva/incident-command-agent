/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Zustand store for one run: the full event array, the head projection, and a scrubber cursor.
 * `view` is the projection at the cursor (or the head when live); `events` is the array up to the cursor.
 * One store per stream: the cockpit keeps a second one for the paired baseline run (aligned on simMinute).
 */
import type { RunEvent, RunProjection } from '@ica/schema/browser';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { StreamStatus } from '../lib/runStream';
import { EventLog } from './eventLog';

export interface RunState {
  runId: string | null;
  log: EventLog;
  /** Increments on every append (the log itself is mutable). */
  version: number;
  head: RunProjection;
  /** null = live (follow the head). */
  cursorSeq: number | null;
  view: RunProjection;
  /** Events up to the cursor (the head when live). */
  events: RunEvent[];
  status: StreamStatus;
  loadError: string | null;
  reset(runId: string | null): void;
  append(events: readonly RunEvent[]): void;
  setCursor(seq: number | null): void;
  setCursorAtMinute(minute: number): void;
  setStatus(status: StreamStatus): void;
  setLoadError(message: string | null): void;
}

export type RunStore = StoreApi<RunState>;

export function createRunStore(runId: string | null = null): RunStore {
  return createStore<RunState>()((set, get) => {
    const derive = (log: EventLog, cursorSeq: number | null) => ({
      view: cursorSeq === null ? log.head : log.at(cursorSeq),
      // A fresh array per change so memoised selectors see the update (the log itself is append-only).
      events: cursorSeq === null ? log.events.slice() : log.upTo(cursorSeq),
      head: log.head,
    });
    const initial = new EventLog(runId);
    return {
      runId,
      log: initial,
      version: 0,
      cursorSeq: null,
      status: 'idle',
      loadError: null,
      ...derive(initial, null),
      reset(id) {
        const log = new EventLog(id);
        set({
          runId: id,
          log,
          version: 0,
          cursorSeq: null,
          status: 'idle',
          loadError: null,
          ...derive(log, null),
        });
      },
      append(events) {
        const { log, cursorSeq, version } = get();
        if (log.append(events) === 0) return;
        set({ version: version + 1, ...derive(log, cursorSeq) });
      },
      setCursor(seq) {
        const { log } = get();
        const cursor = seq === null || seq >= log.lastSeq ? null : Math.max(0, seq);
        set({ cursorSeq: cursor, ...derive(log, cursor) });
      },
      setCursorAtMinute(minute) {
        const { log } = get();
        const headMinute = log.head.simMinute;
        get().setCursor(minute >= headMinute ? null : log.seqAtMinute(minute));
      },
      setStatus(status) {
        set({ status });
      },
      setLoadError(message) {
        set({ loadError: message });
      },
    };
  });
}
