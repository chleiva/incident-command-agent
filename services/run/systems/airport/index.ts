/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * airport — airport operations (spec §7).
 *
 * Rules:
 * - A stand request confirms at `requestedAt + modelledDelay` (3–8 min, seeded) unless the stand is occupied by
 *   another aircraft at that moment → `rejected`. On confirmation the aircraft moves: the new stand is occupied,
 *   the old one freed, and the mne aircraft record updated.
 * - Stands with `occupiedUntilMinute` free themselves at that minute.
 * - Tow, bus, stairs and GPU requests are ETA-based and take a unit from the handler's equipment pool
 *   (tow → tug); status `confirmed → en_route (ETA − 5) → on_site (ETA) → released`, restoring the pool.
 * - The airport fire service is always available at the incident station (ETA 3–5 min, no pool).
 */
import type {
  EquipmentKind,
  MockSystem,
  ResourceRequest,
  Scenario,
  StandRequest,
  SystemMutation,
  SystemState,
  SystemStateOf,
  Weather,
} from '@ica/schema';
import { ackAt, reserveEquipment, restoreEquipment } from '../handler/index';
import { applyMutations, created, fail, newId, randInt, updated, type Result } from '../util';

export function seedAirport(scenario: Scenario): SystemStateOf<'airport'> {
  const stands: SystemStateOf<'airport'>['stands'] = {};
  for (const s of scenario.world.stands) stands[s.id] = { ...s };
  const w = scenario.world.weather;
  const weather: Record<string, Weather> = { [w.station]: { ...w } };
  return { stands, standRequests: {}, resourceRequests: {}, weather };
}

/** Occupied by another aircraft at `minute`? */
export function standOccupied(
  state: SystemState,
  standId: string,
  tail: string,
  minute: number,
): string | undefined {
  const s = state.airport.stands[standId];
  if (!s?.occupiedByTail || s.occupiedByTail === tail) return undefined;
  if (s.occupiedUntilMinute !== undefined && s.occupiedUntilMinute <= minute) return undefined;
  return s.occupiedByTail;
}

export function requestStand(
  state: SystemState,
  input: { standId: string; tail: string },
  simMinute: number,
  rng: () => number,
): Result<StandRequest> {
  const stand = state.airport.stands[input.standId];
  if (!stand) return fail(`unknown stand ${input.standId}`);
  const ac = state.mne.aircraft[input.tail];
  if (!ac) return fail(`unknown tail ${input.tail}`);
  if (stand.station !== ac.station)
    return fail(`stand ${stand.id} is at ${stand.station}; ${ac.tail} is at ${ac.station}`);
  if (ac.stand === stand.id) return fail(`${ac.tail} is already on stand ${stand.id}`);
  const pending = Object.values(state.airport.standRequests).find(
    (r) => r.tail === input.tail && r.status === 'requested',
  );
  if (pending)
    return fail(`${input.tail} already has a pending stand request ${pending.id} (stand ${pending.standId})`);
  const id = newId('SR', state.airport.standRequests, rng);
  const req: StandRequest = {
    id,
    standId: stand.id,
    tail: input.tail,
    status: 'requested',
    confirmAtMinute: simMinute + randInt(rng, 3, 8),
  };
  return { ok: true, value: req, mutations: [created('airport', 'standRequests', id, req)] };
}

const RESOURCE_EQUIPMENT: Partial<Record<ResourceRequest['kind'], EquipmentKind>> = {
  tow: 'tug',
  bus: 'bus',
  stairs: 'stairs',
  gpu: 'gpu',
};
/** Minutes a resource stays on site before release. */
const HOLD_MIN: Record<ResourceRequest['kind'], number> = {
  tow: 25,
  bus: 30,
  stairs: 60,
  gpu: 90,
  fire_service: 45,
  medical: 60,
  police: 60,
};

export function requestResource(
  state: SystemState,
  input: { kind: ResourceRequest['kind']; station: string; tail?: string },
  simMinute: number,
  ackMinutes: number,
  rng: () => number,
): Result<ResourceRequest> {
  const mutations: SystemMutation[] = [];
  const eq = RESOURCE_EQUIPMENT[input.kind];
  if (eq) {
    const r = reserveEquipment(state, input.station, eq);
    if (!r.ok) return r;
    mutations.push(...r.mutations);
  }
  const eta =
    input.kind === 'fire_service'
      ? simMinute + randInt(rng, 3, 5)
      : input.kind === 'tow'
        ? ackAt(simMinute, ackMinutes, rng) + randInt(rng, 8, 15)
        : input.kind === 'bus'
          ? simMinute + randInt(rng, 8, 15)
          : simMinute + randInt(rng, 5, 12);
  const id = newId('RR', state.airport.resourceRequests, rng);
  const req: ResourceRequest = {
    id,
    kind: input.kind,
    station: input.station,
    status: 'confirmed',
    etaMinute: eta,
    releaseAtMinute: eta + HOLD_MIN[input.kind],
    ...(input.tail ? { tail: input.tail } : {}),
  };
  mutations.push(created('airport', 'resourceRequests', id, req));
  return { ok: true, value: req, mutations };
}

export function tickAirport(state: SystemState, simMinute: number, _dtMin: number): SystemMutation[] {
  const out: SystemMutation[] = [];
  let s = state;
  const push = (ms: SystemMutation[]) => {
    out.push(...ms);
    s = applyMutations(s, ms);
  };
  // Stands whose occupant leaves.
  for (const st of Object.values(s.airport.stands)) {
    if (st.occupiedByTail && st.occupiedUntilMinute !== undefined && st.occupiedUntilMinute <= simMinute)
      push([
        updated('airport', 'stands', st.id, st, {
          occupiedByTail: undefined,
          occupiedUntilMinute: undefined,
        }),
      ]);
  }
  // Stand confirmations.
  for (const r of Object.values(s.airport.standRequests)) {
    if (r.status !== 'requested' || simMinute < r.confirmAtMinute) continue;
    if (standOccupied(s, r.standId, r.tail, simMinute)) {
      push([updated('airport', 'standRequests', r.id, r, { status: 'rejected' })]);
      continue;
    }
    const ms: SystemMutation[] = [updated('airport', 'standRequests', r.id, r, { status: 'confirmed' })];
    const target = s.airport.stands[r.standId];
    ms.push(
      updated('airport', 'stands', target.id, target, {
        occupiedByTail: r.tail,
        occupiedUntilMinute: undefined,
      }),
    );
    for (const old of Object.values(s.airport.stands))
      if (old.id !== target.id && old.occupiedByTail === r.tail)
        ms.push(
          updated('airport', 'stands', old.id, old, {
            occupiedByTail: undefined,
            occupiedUntilMinute: undefined,
          }),
        );
    const ac = s.mne.aircraft[r.tail];
    if (ac) ms.push(updated('mne', 'aircraft', ac.tail, ac, { stand: target.id }));
    push(ms);
  }
  // Resource requests.
  for (const r of Object.values(s.airport.resourceRequests)) {
    if (r.status === 'confirmed' && simMinute >= r.etaMinute - 5)
      push([
        updated('airport', 'resourceRequests', r.id, r, {
          status: simMinute >= r.etaMinute ? 'on_site' : 'en_route',
        }),
      ]);
    else if (r.status === 'en_route' && simMinute >= r.etaMinute)
      push([updated('airport', 'resourceRequests', r.id, r, { status: 'on_site' })]);
    else if (r.status === 'on_site' && r.releaseAtMinute !== undefined && simMinute >= r.releaseAtMinute) {
      const ms = [updated('airport', 'resourceRequests', r.id, r, { status: 'released' })];
      const eq = RESOURCE_EQUIPMENT[r.kind];
      if (eq) ms.push(...restoreEquipment(s, r.station, eq));
      push(ms);
    }
  }
  return out;
}

export const airport: MockSystem<'airport'> = {
  name: 'airport',
  seed: (scenario) => seedAirport(scenario),
  tick: tickAirport,
  knownRefs: (state) => ({
    stand: Object.keys(state.airport.stands),
    station: [
      ...new Set([
        ...Object.values(state.airport.stands).map((s) => s.station),
        ...Object.keys(state.airport.weather),
      ]),
    ],
  }),
};
