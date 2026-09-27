/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * The full event array of one run plus projections rebuilt with the shared pure reducer (`applyEvent`).
 * Checkpoints every `CHECKPOINT_EVERY` events keep `at(seq)` cheap, so scrubbing a 5,000-event run folds at most
 * 199 events per frame.
 */
import { applyEvent, emptyProjection, type RunEvent, type RunProjection } from '@ica/schema/browser';

export const CHECKPOINT_EVERY = 200;

export class EventLog {
  readonly events: RunEvent[] = [];
  /** checkpoints[i] = projection after the first (i + 1) × CHECKPOINT_EVERY events. */
  private readonly checkpoints: RunProjection[] = [];
  private headProjection: RunProjection;
  private cache: { seq: number; p: RunProjection } | null = null;

  constructor(readonly runId: string | null = null) {
    this.headProjection = emptyProjection(runId);
  }

  get head(): RunProjection {
    return this.headProjection;
  }

  get lastSeq(): number {
    return this.headProjection.lastSeq;
  }

  get firstSeq(): number {
    return this.events[0]?.seq ?? 0;
  }

  /** Append events in seq order; duplicates (seq ≤ lastSeq) are ignored. Returns the number appended. */
  append(batch: readonly RunEvent[]): number {
    let n = 0;
    for (const e of batch) {
      if (e.seq <= this.headProjection.lastSeq) continue;
      this.headProjection = applyEvent(this.headProjection, e);
      this.events.push(e);
      n += 1;
      if (this.events.length % CHECKPOINT_EVERY === 0) this.checkpoints.push(this.headProjection);
    }
    return n;
  }

  /** Index (0-based) of the last event with `seq ≤ seq`, or -1. */
  indexAtSeq(seq: number): number {
    let lo = 0;
    let hi = this.events.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.events[mid]!.seq <= seq) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans;
  }

  /** Seq of the last event at or before `minute` (0 when none). */
  seqAtMinute(minute: number): number {
    let lo = 0;
    let hi = this.events.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.events[mid]!.simMinute <= minute) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans < 0 ? 0 : this.events[ans]!.seq;
  }

  /** The projection as of `seq` (inclusive), rebuilt from the nearest checkpoint with the shared reducer. */
  at(seq: number): RunProjection {
    if (seq >= this.headProjection.lastSeq) return this.headProjection;
    if (this.cache?.seq === seq) return this.cache.p;
    const idx = this.indexAtSeq(seq);
    if (idx < 0) return emptyProjection(this.runId);
    const cpIndex = Math.floor((idx + 1) / CHECKPOINT_EVERY) - 1;
    let p = cpIndex >= 0 ? this.checkpoints[cpIndex]! : emptyProjection(this.runId);
    const from = cpIndex >= 0 ? (cpIndex + 1) * CHECKPOINT_EVERY : 0;
    for (let i = from; i <= idx; i++) p = applyEvent(p, this.events[i]!);
    this.cache = { seq, p };
    return p;
  }

  /** Events up to and including `seq` (all when `seq` is null). */
  upTo(seq: number | null): RunEvent[] {
    if (seq === null || seq >= this.lastSeq) return this.events;
    return this.events.slice(0, this.indexAtSeq(seq) + 1);
  }
}
