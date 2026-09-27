/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** Small pure helpers: seeded RNG, id counters, previews and thought summaries. */

/** 32-bit FNV-1a hash of a string (seeds the run RNG from the run id). */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: small, fast, deterministic. */
export function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class IdCounter {
  private counts = new Map<string, number>();
  next(prefix: string): string {
    const n = (this.counts.get(prefix) ?? 0) + 1;
    this.counts.set(prefix, n);
    return `${prefix}-${n}`;
  }

  /**
   * Resume: never hand out an id the run already used. Scans `text` (the serialised event log) for
   * `{prefix}-{n}` of every counter prefix the runtime uses and continues after the highest.
   */
  seedFrom(text: string, prefixes: string[]): void {
    for (const prefix of prefixes) {
      const re = new RegExp(`(?<![A-Za-z0-9-])${prefix.replace(/[-]/g, '\\-')}-(\\d+)(?![0-9])`, 'g');
      let max = this.counts.get(prefix) ?? 0;
      for (const m of text.matchAll(re)) max = Math.max(max, Number(m[1]));
      this.counts.set(prefix, max);
    }
  }
}

/** First sentence of a text, trimmed to ≤ 120 chars (no extra LLM call). */
export function summarise(text: string, max = 120): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const m = /^(.+?[.!?])(\s|$)/.exec(t);
  const first = m ? m[1] : t;
  return first.length <= max ? first : `${first.slice(0, max - 1)}…`;
}

export function preview(value: unknown, max = 500): string {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  if (s === undefined) return '';
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

export function deepClone<T>(x: T): T {
  return x === undefined ? x : (JSON.parse(JSON.stringify(x)) as T);
}
