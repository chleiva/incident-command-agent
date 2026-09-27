/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Clocks. `realClock` for Lambda/local runs; `VirtualClock` for tests, replay and the eval harness (virtual time
 * advances only when every pending task is asleep, so runs are fast and deterministic); `SimClock` for sim time.
 */
import type { WallClock } from '@ica/schema';

export const realClock: WallClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms))),
};

interface Timer {
  at: number;
  seq: number;
  resolve: () => void;
}

/**
 * Deterministic virtual wall clock. `sleep(ms)` registers a timer; a macrotask driver fires the earliest timer
 * (FIFO for equal times) only after all microtask work has settled. Use only with in-memory stores (no real I/O).
 */
export class VirtualClock implements WallClock {
  private t: number;
  private timers: Timer[] = [];
  private seq = 0;
  private scheduled = false;

  constructor(startMs = Date.parse('2026-01-01T00:00:00Z')) {
    this.t = startMs;
  }

  now(): number {
    return this.t;
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.timers.push({ at: this.t + Math.max(0, ms), seq: this.seq++, resolve });
      this.schedule();
    });
  }

  get pending(): number {
    return this.timers.length;
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => this.step());
  }

  private step(): void {
    this.scheduled = false;
    if (!this.timers.length) return;
    let best = 0;
    for (let i = 1; i < this.timers.length; i++) {
      const a = this.timers[i];
      const b = this.timers[best];
      if (a.at < b.at || (a.at === b.at && a.seq < b.seq)) best = i;
    }
    const [timer] = this.timers.splice(best, 1);
    this.t = Math.max(this.t, timer.at);
    timer.resolve();
    if (this.timers.length) this.schedule();
  }
}

/** Sim clock: minutes since `scenario.startSimTime`, a speed multiplier and a pause flag. */
export class SimClock {
  simMinute = 0;
  paused = false;
  private readonly originMs: number;

  constructor(
    startSimTime: string,
    public speed = 6,
  ) {
    this.originMs = Date.parse(startSimTime);
  }

  simTime(minute = this.simMinute): string {
    return new Date(this.originMs + Math.round(minute * 60_000)).toISOString();
  }

  /** Minute of an ISO time on the scenario clock. */
  minuteOf(iso: string): number {
    return (Date.parse(iso) - this.originMs) / 60_000;
  }

  advance(dtMin: number): void {
    this.simMinute = Math.round((this.simMinute + dtMin) * 1e6) / 1e6;
  }
}
