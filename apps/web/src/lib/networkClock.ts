/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * The live-network clock: the real wall clock (UTC) mapped onto Accent Air's fictional day schedule, computed in
 * the browser (zero backend cost). The presenter can jump to a time of day or speed the clock up; "Live" returns to
 * the wall clock.
 */
import { DEFAULT_NETWORK_SEED, generateDaySchedule, utcDate, type DaySchedule } from '@ica/network';
import { useEffect, useMemo, useState } from 'react';
import { create } from 'zustand';

export const NETWORK_SPEEDS = [1, 10, 60, 240] as const;

interface ClockState {
  /** Network time = anchorT + (wall − anchorWall) × speed. */
  anchorT: number;
  anchorWall: number;
  speed: number;
  live: boolean;
  seed: string;
  setSpeed(speed: number): void;
  /** Jump to a minute of the current (network) day, UTC. */
  setMinuteOfDay(minute: number): void;
  goLive(): void;
}

export function networkNowFrom(s: Pick<ClockState, 'anchorT' | 'anchorWall' | 'speed'>, wall = Date.now()) {
  return s.anchorT + (wall - s.anchorWall) * s.speed;
}

function initialSeed(): string {
  try {
    const p = new URLSearchParams(window.location.search).get('network');
    if (p && /^[a-z0-9-]{1,32}$/.test(p)) return p;
  } catch {
    /* no window */
  }
  return DEFAULT_NETWORK_SEED;
}

/** Optional `?at=HH:MM` start time (screenshots, tests). */
function initialAnchor(): { anchorT: number; live: boolean } {
  const now = Date.now();
  try {
    const at = new URLSearchParams(window.location.search).get('at');
    const m = at ? /^([01]\d|2[0-3]):([0-5]\d)$/.exec(at) : null;
    if (m) {
      const day0 = Date.parse(`${utcDate(now)}T00:00:00Z`);
      return { anchorT: day0 + (Number(m[1]) * 60 + Number(m[2])) * 60_000, live: false };
    }
  } catch {
    /* no window */
  }
  return { anchorT: now, live: true };
}

export const useNetworkClock = create<ClockState>((set, get) => ({
  ...initialAnchor(),
  anchorWall: Date.now(),
  speed: 1,
  seed: initialSeed(),
  setSpeed: (speed) => {
    const wall = Date.now();
    set({ anchorT: networkNowFrom(get(), wall), anchorWall: wall, speed, live: false });
  },
  setMinuteOfDay: (minute) => {
    const wall = Date.now();
    const day0 = Date.parse(`${utcDate(networkNowFrom(get(), wall))}T00:00:00Z`);
    set({ anchorT: day0 + minute * 60_000, anchorWall: wall, live: false });
  },
  goLive: () => set({ anchorT: Date.now(), anchorWall: Date.now(), speed: 1, live: true }),
}));

/** Network time now (for animation frames; no React subscription). */
export function networkNow(): number {
  return networkNowFrom(useNetworkClock.getState());
}

/** Network time, re-rendered every `intervalMs` (lists, panels). */
export function useNetworkTime(intervalMs = 1000): number {
  const clock = useNetworkClock();
  const [t, setT] = useState(() => networkNowFrom(clock));
  useEffect(() => {
    setT(networkNowFrom(clock));
    const id = setInterval(() => setT(networkNowFrom(useNetworkClock.getState())), intervalMs);
    return () => clearInterval(id);
  }, [clock.anchorT, clock.anchorWall, clock.speed, intervalMs]);
  return t;
}

const cache = new Map<string, DaySchedule>();

/** The day's schedule for a seed and UTC date (memoised; deterministic). */
export function scheduleFor(seed: string, date: string): DaySchedule {
  const key = `${seed}|${date}`;
  let s = cache.get(key);
  if (!s) {
    s = generateDaySchedule(seed, date);
    cache.set(key, s);
    if (cache.size > 4) cache.delete(cache.keys().next().value!);
  }
  return s;
}

/** The schedule for the network clock's current day. */
export function useNetworkSchedule(t: number): DaySchedule {
  const seed = useNetworkClock((s) => s.seed);
  const date = utcDate(t);
  return useMemo(() => scheduleFor(seed, date), [seed, date]);
}
