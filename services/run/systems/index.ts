/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Mocked-system registry (spec §7). One folder per system; every system is pure: `seed`, `tick` and the helpers
 * return data and `SystemMutation[]` (with FULL `after` entities); the runtime persists them.
 *
 * Tick order matters within one world tick (engineers arrive before work orders start, flights slip after the
 * aircraft status is known): engineers → handler → airport → mne → occ → crew → pss → record.
 */
import type { MockSystem, RefKind, Scenario, SystemMutation, SystemState } from '@ica/schema';
import { airport } from './airport/index';
import { crew } from './crew/index';
import { engineers } from './engineers/index';
import { handler } from './handler/index';
import { mne } from './mne/index';
import { occ } from './occ/index';
import { pss } from './pss/index';
import { record } from './record/index';
import { applyMutations } from './util';

export const systems: MockSystem<any>[] = [engineers, handler, airport, mne, occ, crew, pss, record];

/** Seed every system (plus an empty `record` store) from a scenario. Deterministic for a given rng. */
export function seedAll(scenario: Scenario, rng: () => number): SystemState {
  const out: Record<string, unknown> = {};
  for (const s of systems) out[s.name as string] = s.seed(scenario, rng);
  return out as SystemState;
}

/**
 * Run every system's `tick` in order, each seeing the previous systems' changes. Returns all mutations (the world
 * engine may call the systems itself; this is the reference behaviour, used by tests and baseline previews).
 */
export function tickAll(state: SystemState, simMinute: number, dtMin: number): SystemMutation[] {
  const out: SystemMutation[] = [];
  let s = state;
  for (const sys of systems) {
    const ms = sys.tick(s, simMinute, dtMin);
    if (ms.length) {
      out.push(...ms);
      s = applyMutations(s, ms);
    }
  }
  return out;
}

/** Union of every system's known references (for the runtime's ref validation). */
export function knownRefs(state: SystemState): Partial<Record<RefKind, string[]>> {
  const out: Partial<Record<RefKind, Set<string>>> = {};
  for (const sys of systems)
    for (const [k, ids] of Object.entries(sys.knownRefs(state)) as [RefKind, string[]][])
      for (const id of ids) (out[k] ??= new Set()).add(id);
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, [...v!].sort()])) as Partial<
    Record<RefKind, string[]>
  >;
}

export { applyMutations } from './util';
