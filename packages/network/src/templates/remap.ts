/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Deterministic identifier remapping for templates: whole-token replacement (tails, flights, cohort and crew ids,
 * IATA/ICAO codes, city names, lower-case station codes inside ids), ISO date-times shifted by a fixed offset and
 * HH:MM times in free text shifted by the same offset. Used to move a shipped scenario (or a recorded run) onto a
 * flight from the live network. Pure.
 */

export interface RemapSpec {
  /** Whole-token replacements (case-sensitive): tails, flights, ids, IATA/ICAO codes, city names. */
  tokens: Record<string, string>;
  /** Lower-case station codes inside ids (e.g. `eng-man-b1`), keyed by lower-case code. */
  idCodes: Record<string, string>;
  /** Offset applied to ISO date-times and HH:MM text. */
  shiftMs: number;
}

const ISO_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?)Z$/;
const HHMM_RE = /(?<![\d:T])([01]\d|2[0-3]):([0-5]\d)(?![\d:])/g;
/** Keys whose values are local wall-clock times that must not move (curfews). */
const FIXED_TIME_KEYS = new Set(['fromLocal', 'toLocal']);

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export interface Remapper {
  string(s: string, key?: string): string;
  value<T>(v: T): T;
  spec: RemapSpec;
}

export function createRemapper(spec: RemapSpec): Remapper {
  const keys = Object.keys(spec.tokens)
    .filter((k) => spec.tokens[k] !== k)
    .sort((a, b) => b.length - a.length);
  const tokenRe = keys.length
    ? new RegExp(`(?<![A-Za-z0-9])(${keys.map(escape).join('|')})(?![A-Za-z0-9])`, 'g')
    : null;
  const idKeys = Object.keys(spec.idCodes).filter((k) => spec.idCodes[k] !== k);
  const idRe = idKeys.length
    ? new RegExp(`(?<=^|[-_:])(${idKeys.map(escape).join('|')})(?=[-_:]|$)`, 'g')
    : null;
  const shiftMin = Math.round(spec.shiftMs / 60_000);

  const shiftIso = (s: string): string => {
    const ms = Date.parse(s);
    if (Number.isNaN(ms)) return s;
    const out = new Date(ms + spec.shiftMs).toISOString();
    return s.includes('.') ? out : out.replace(/\.\d{3}Z$/, 'Z');
  };

  const str = (s: string, key?: string): string => {
    if (ISO_RE.test(s)) return spec.shiftMs ? shiftIso(s) : s;
    let out = s;
    if (tokenRe) out = out.replace(tokenRe, (m) => spec.tokens[m] ?? m);
    // Lower-case codes only inside id-like strings (no spaces), never in prose.
    if (idRe && !/\s/.test(out)) out = out.replace(idRe, (m) => spec.idCodes[m] ?? m);
    if (shiftMin && !(key && FIXED_TIME_KEYS.has(key)))
      out = out.replace(HHMM_RE, (_m, h: string, mm: string) => {
        const t = (((Number(h) * 60 + Number(mm) + shiftMin) % 1440) + 1440) % 1440;
        return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
      });
    return out;
  };

  const val = (v: unknown, key?: string): unknown => {
    if (typeof v === 'string') return str(v, key);
    if (Array.isArray(v)) return v.map((x) => val(x, key));
    if (v && typeof v === 'object') {
      const o: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        const nk = tokenRe ? k.replace(tokenRe, (m) => spec.tokens[m] ?? m) : k;
        o[nk] = val(x, k);
      }
      return o;
    }
    return v;
  };

  return { string: str, value: <T>(v: T) => val(v) as T, spec };
}

/** Remove duplicate strings from every string array in a value (after several ids were mapped onto one). */
export function dedupeStringArrays<T>(v: T): T {
  if (Array.isArray(v)) {
    const mapped = v.map((x) => dedupeStringArrays(x));
    return (mapped.every((x) => typeof x === 'string') ? [...new Set(mapped)] : mapped) as T;
  }
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) o[k] = dedupeStringArrays(x);
    return o as T;
  }
  return v;
}
