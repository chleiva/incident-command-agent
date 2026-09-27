/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * handler — ground handling provider (spec §7).
 *
 * Rules:
 * - Tasks are acknowledged after the handler's `ackMinutes` (± seeded jitter, never under 1 min), then run for a
 *   duration that depends on the task kind, then complete.
 * - Equipment pools (`{station}:{kind}`) decrement when a task or resource request takes a unit and restore when it
 *   completes/releases. An empty pool refuses the request.
 */
import type {
  EquipmentKind,
  EquipmentPool,
  HandlerTask,
  MockSystem,
  Scenario,
  SystemMutation,
  SystemState,
  SystemStateOf,
} from '@ica/schema';
import { applyMutations, created, fail, newId, randInt, updated, type Result } from '../util';

export const HANDLER_TASK_KINDS = [
  'tow',
  'stairs',
  'gpu',
  'acu',
  'offload_bags',
  'hold_loading',
  'hold_boarding',
  'deboard_passengers',
  'fuel_spill_cleanup',
  'cabin_clean',
  'catering_hold',
  'marshalling',
  'damage_inspection_access',
  'foreign_object_sweep',
  'prm_assistance',
  // task 07: an aircraft arriving from a diversion or turnback
  'diversion_handling',
  'refuel',
  'catering_uplift',
  'hotel_hold',
  'station_notification',
] as const;
export type HandlerTaskKind = (typeof HANDLER_TASK_KINDS)[number];

/** Minutes a task runs after acknowledgement. */
export const TASK_DURATION_MIN: Record<HandlerTaskKind, number> = {
  tow: 20,
  stairs: 10,
  gpu: 5,
  acu: 5,
  offload_bags: 30,
  hold_loading: 2,
  hold_boarding: 2,
  deboard_passengers: 20,
  fuel_spill_cleanup: 40,
  cabin_clean: 25,
  catering_hold: 2,
  marshalling: 10,
  damage_inspection_access: 15,
  foreign_object_sweep: 15,
  prm_assistance: 20,
  diversion_handling: 30,
  refuel: 25,
  catering_uplift: 30,
  hotel_hold: 20,
  station_notification: 1,
};

const TASK_TEXT: Record<HandlerTaskKind, string> = {
  tow: 'Tow the aircraft',
  stairs: 'Position passenger stairs',
  gpu: 'Connect ground power unit',
  acu: 'Connect air conditioning unit',
  offload_bags: 'Offload hold baggage',
  hold_loading: 'Stop loading and hold',
  hold_boarding: 'Stop boarding and hold passengers at the gate',
  deboard_passengers: 'Disembark passengers',
  fuel_spill_cleanup: 'Contain and clean up fuel spill',
  cabin_clean: 'Clean the cabin',
  catering_hold: 'Hold catering service',
  marshalling: 'Provide marshaller and wing walkers',
  damage_inspection_access: 'Provide access equipment for damage inspection',
  foreign_object_sweep: 'FOD sweep of the stand',
  prm_assistance: 'Assist passengers with reduced mobility',
  diversion_handling: 'Handle an unscheduled arrival (turnaround team, stand, steps)',
  refuel: 'Arrange refuelling',
  catering_uplift: 'Arrange catering and water uplift',
  hotel_hold: 'Hold hotel rooms for passengers and crew',
  station_notification: 'Station informed of the flight change',
};

export const poolId = (station: string, kind: EquipmentKind) => `${station}:${kind}`;

export function seedHandler(scenario: Scenario): SystemStateOf<'handler'> {
  const h = scenario.world.handler;
  const equipment: Record<string, EquipmentPool> = {};
  for (const e of h.equipment) {
    const id = poolId(h.station, e.kind);
    equipment[id] = { id, station: h.station, kind: e.kind, available: e.count, total: e.count };
  }
  return { tasks: {}, equipment, reports: {} };
}

/** Take one unit from a pool. */
export function reserveEquipment(
  state: SystemState,
  station: string,
  kind: EquipmentKind,
): Result<EquipmentPool> {
  const pool = state.handler.equipment[poolId(station, kind)];
  if (!pool) return fail(`the handler has no ${kind} at ${station}`);
  if (pool.available <= 0) return fail(`no ${kind} available at ${station} (0 of ${pool.total} free)`);
  const m = updated('handler', 'equipment', pool.id, pool, { available: pool.available - 1 });
  return { ok: true, value: m.after as EquipmentPool, mutations: [m] };
}

/** Return one unit to a pool (never above total). */
export function restoreEquipment(state: SystemState, station: string, kind: EquipmentKind): SystemMutation[] {
  const pool = state.handler.equipment[poolId(station, kind)];
  if (!pool || pool.available >= pool.total) return [];
  return [updated('handler', 'equipment', pool.id, pool, { available: pool.available + 1 })];
}

/** Acknowledgement minute: ackMinutes ± seeded jitter (−1…+2), at least 1 minute after now. */
export function ackAt(simMinute: number, ackMinutes: number, rng: () => number): number {
  return simMinute + Math.max(1, ackMinutes + randInt(rng, -1, 2));
}

export function createHandlerTask(
  state: SystemState,
  input: {
    station: string;
    kind: HandlerTaskKind;
    tail?: string;
    equipmentKind?: EquipmentKind;
    priority?: 'normal' | 'urgent';
  },
  simMinute: number,
  ackMinutes: number,
  rng: () => number,
): Result<HandlerTask> {
  const mutations: SystemMutation[] = [];
  if (input.equipmentKind) {
    const r = reserveEquipment(state, input.station, input.equipmentKind);
    if (!r.ok) return r;
    mutations.push(...r.mutations);
  }
  const id = newId('HT', state.handler.tasks, rng);
  const ack = ackAt(simMinute, input.priority === 'urgent' ? Math.max(1, ackMinutes - 2) : ackMinutes, rng);
  const note = [
    TASK_TEXT[input.kind],
    input.tail ? `for ${input.tail}` : '',
    input.equipmentKind ? `(1 × ${input.equipmentKind} reserved)` : '',
    input.priority === 'urgent' ? '— URGENT' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const task: HandlerTask = {
    id,
    station: input.station,
    kind: input.kind,
    status: 'queued',
    ackAtMinute: ack,
    doneAtMinute: ack + TASK_DURATION_MIN[input.kind],
    note,
    ...(input.tail ? { tail: input.tail } : {}),
    ...(input.equipmentKind ? { equipmentKind: input.equipmentKind } : {}),
  };
  mutations.push(created('handler', 'tasks', id, task));
  return { ok: true, value: task, mutations };
}

export function tickHandler(state: SystemState, simMinute: number, _dtMin: number): SystemMutation[] {
  const out: SystemMutation[] = [];
  let s = state;
  for (const t of Object.values(state.handler.tasks)) {
    if (t.status === 'queued' && simMinute >= t.ackAtMinute)
      out.push(updated('handler', 'tasks', t.id, t, { status: 'acknowledged' }));
    else if (t.status === 'acknowledged' && simMinute >= t.ackAtMinute + 1)
      out.push(updated('handler', 'tasks', t.id, t, { status: 'in_progress' }));
    else if (t.status === 'in_progress' && t.doneAtMinute !== undefined && simMinute >= t.doneAtMinute) {
      out.push(updated('handler', 'tasks', t.id, t, { status: 'done' }));
      if (t.equipmentKind) {
        const r = restoreEquipment(s, t.station, t.equipmentKind);
        out.push(...r);
        s = applyMutations(s, r);
      }
    }
  }
  return out;
}

export const handler: MockSystem<'handler'> = {
  name: 'handler',
  seed: (scenario) => seedHandler(scenario),
  tick: tickHandler,
  knownRefs: (state) => ({
    station: [...new Set(Object.values(state.handler.equipment).map((e) => e.station))],
  }),
};
