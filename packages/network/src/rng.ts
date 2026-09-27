/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** Small deterministic PRNG (mulberry32 over an FNV-1a string hash). No Node or browser APIs. */

/** FNV-1a 32-bit hash of a string. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number;
  /** One element of a non-empty array. */
  pick<T>(xs: readonly T[]): T;
  /** True with probability p. */
  chance(p: number): boolean;
}

export function createRng(seed: string | number): Rng {
  let a = typeof seed === 'number' ? seed >>> 0 : hashString(seed);
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: <T>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)]!,
    chance: (p) => next() < p,
  };
}
