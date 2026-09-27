/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** Small pure helpers shared by the mocked systems and the tools. */
import type {
  Actor,
  EntityName,
  StateSystemName,
  SystemEntityTypes,
  SystemMutation,
  SystemState,
} from '@ica/schema';

export type Entity<S extends StateSystemName, E extends EntityName<S>> = SystemEntityTypes[S][E];

/** Minimum turn time used by swap and reactionary-delay rules (minutes). */
export const MIN_TURN_MIN = 35;

const clone = <T>(x: T): T => structuredClone(x);

/** A `create` mutation carrying the full entity. */
export function created<S extends StateSystemName, E extends EntityName<S>>(
  system: S,
  entity: E,
  id: string,
  after: Entity<S, E>,
): SystemMutation {
  return { system, entity, id, op: 'create', after: clone(after) as Record<string, unknown> };
}

/** An `update` mutation: `after` is the FULL entity (before + patch). */
export function updated<S extends StateSystemName, E extends EntityName<S>>(
  system: S,
  entity: E,
  id: string,
  before: Entity<S, E>,
  patch: Partial<Entity<S, E>>,
): SystemMutation {
  const after = { ...clone(before), ...clone(patch) } as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) if (v === undefined) delete after[k];
  return {
    system,
    entity,
    id,
    op: 'update',
    before: clone(before) as Record<string, unknown>,
    after,
  };
}

/** True when an `updated()` patch would actually change something. */
export function changes<T extends object>(before: T, patch: Partial<T>): boolean {
  return Object.entries(patch).some(([k, v]) => JSON.stringify((before as any)[k]) !== JSON.stringify(v));
}

/** Apply mutations to a state copy (tests, local previews, chained helper calls). Pure. */
export function applyMutations(state: SystemState, mutations: SystemMutation[]): SystemState {
  const next = clone(state) as unknown as Record<string, Record<string, Record<string, unknown>>>;
  for (const m of mutations) {
    const map = (next[m.system] ??= {})[m.entity] ?? (next[m.system][m.entity] = {});
    if (m.op === 'delete') delete map[m.id];
    else map[m.id] = clone(m.after);
  }
  return next as unknown as SystemState;
}

/**
 * Merge a sequential mutation list into one net mutation per row (`system/entity/id`), placed where the row was
 * first touched: `before` from the first, `after` from the last (create→update = create, create→delete = nothing,
 * delete→create = update). Chained helpers (re-tail then re-time a flight) otherwise emit two mutations for one row,
 * which one DynamoDB transaction cannot hold. Pure.
 */
export function netMutations(mutations: SystemMutation[]): SystemMutation[] {
  const byKey = new Map<string, { first: SystemMutation; last: SystemMutation; count: number }>();
  const order: string[] = [];
  for (const m of mutations) {
    const k = `${m.system}#${m.entity}#${m.id}`;
    const cur = byKey.get(k);
    if (cur) {
      cur.last = m;
      cur.count++;
    } else {
      byKey.set(k, { first: m, last: m, count: 1 });
      order.push(k);
    }
  }
  const out: SystemMutation[] = [];
  for (const k of order) {
    const { first, last, count } = byKey.get(k)!;
    if (count === 1) {
      out.push(first);
      continue;
    }
    const existedBefore = first.op !== 'create';
    if (last.op === 'delete') {
      if (existedBefore) out.push({ ...last, ...(first.before ? { before: clone(first.before) } : {}) });
      continue;
    }
    out.push({
      system: last.system,
      entity: last.entity,
      id: last.id,
      op: existedBefore ? 'update' : 'create',
      ...(existedBefore && first.before ? { before: clone(first.before) } : {}),
      after: clone(last.after),
    } as SystemMutation);
  }
  return out;
}

/**
 * Deterministic, collision-resistant id: `PREFIX-NNN-xyz` where NNN is one more than the current count and xyz comes
 * from the seeded rng (two concurrent tool calls reading the same state still get different ids).
 */
export function newId(prefix: string, existing: Record<string, unknown>, rng: () => number): string {
  const n = Object.keys(existing).length + 1;
  const suffix = Math.floor(rng() * 36 ** 3)
    .toString(36)
    .padStart(3, '0');
  return `${prefix}-${String(n).padStart(3, '0')}-${suffix}`;
}

/** Sim minute of an ISO instant relative to the scenario origin. */
export function minuteOf(originIso: string, iso: string): number {
  return (Date.parse(iso) - Date.parse(originIso)) / 60_000;
}

/** ISO instant of a sim minute. */
export function isoAt(originIso: string, minute: number): string {
  return new Date(Date.parse(originIso) + Math.round(minute * 60_000)).toISOString().replace(/\.000Z$/, 'Z');
}

/**
 * The scenario origin (sim minute 0) as epoch ms, recovered from any flight that carries `stdMinute` (pure `tick()`s
 * do not receive the scenario). Undefined if no flight has one.
 */
export function originMs(state: SystemState): number | undefined {
  for (const f of Object.values(state.occ.flights)) {
    if (typeof f.stdMinute === 'number') return Date.parse(f.std) - f.stdMinute * 60_000;
  }
  return undefined;
}

/** Sim minute of an ISO instant, using the origin recovered from state. */
export function stateMinuteOf(state: SystemState, iso: string): number | undefined {
  const o = originMs(state);
  return o === undefined ? undefined : (Date.parse(iso) - o) / 60_000;
}

export function stateIsoAt(state: SystemState, minute: number): string | undefined {
  const o = originMs(state);
  return o === undefined
    ? undefined
    : new Date(o + Math.round(minute * 60_000)).toISOString().replace(/\.000Z$/, 'Z');
}

/** Round a minute up to the next multiple of `step`. */
export const ceilTo = (m: number, step = 5) => Math.ceil(m / step - 1e-9) * step;

/** Seeded integer in [min, max]. */
export function randInt(rng: () => number, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

/** Human-readable actor label. */
export function actorLabel(a: Actor | undefined): string {
  if (!a) return 'unknown';
  switch (a.kind) {
    case 'human':
      return `${a.name} (${a.roleTitle})`;
    case 'agent':
      return `${a.role} agent`;
    case 'policy':
      return a.policy === 'simulation-auto' ? 'Auto-approved (simulation)' : `${a.policy} policy`;
    case 'world':
      return 'world';
  }
}

/** A certifying human: `kind: 'human'` and a roleTitle containing "Certifying" (the mne rule). */
export function isCertifyingHuman(a: Actor | undefined): boolean {
  return !!a && a.kind === 'human' && /certifying/i.test(a.roleTitle);
}

/** Result type for pure helpers. */
export type Result<T> = { ok: true; value: T; mutations: SystemMutation[] } | { ok: false; error: string };
export const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });
