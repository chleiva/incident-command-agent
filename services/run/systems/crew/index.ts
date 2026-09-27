/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * crew — crew management (spec §7).
 *
 * Rules:
 * - `fdpUsedMin` grows with sim time after `reportTime`; `fdpRemainingMin = maxFdpMin − used − remaining planned`,
 *   where "remaining planned" runs from now to the projected on-blocks of the member's last planned sector (so
 *   delays eat the margin).
 * - Any extension beyond `maxFdpMin` is refused (commander's discretion is a human decision, recorded through a
 *   discretion report, never applied by software).
 * - A standby assignment needs the same rank as the member replaced, the standby at the flight's origin, and
 *   enough FDP for the remaining sectors reported from now.
 */
import {
  emptySystemState,
  type CrewMember,
  type Flight,
  type MockSystem,
  type Scenario,
  type SystemMutation,
  type SystemState,
  type SystemStateOf,
} from '@ica/schema';
import { etaMin, isActive, seedOcc, stdMin } from '../occ/index';
import { fail, originMs, stateIsoAt, stateMinuteOf, updated, type Result } from '../util';

/** The flights a crew member still has to operate, starting at `assignedFlight`, following station continuity. */
export function pairing(state: SystemState, member: CrewMember): Flight[] {
  const first = member.assignedFlight ? state.occ.flights[member.assignedFlight] : undefined;
  if (!first || member.sectorsPlanned <= 0) return [];
  const legs: Flight[] = [first];
  let prev = first;
  while (legs.length < member.sectorsPlanned) {
    const cands = Object.values(state.occ.flights)
      .filter((f) => f.from === prev.to && stdMin(state, f) > stdMin(state, prev) && !legs.includes(f))
      .sort((a, b) => stdMin(state, a) - stdMin(state, b));
    const next = cands.find((f) => f.tail === prev.tail) ?? cands[0];
    if (!next) break;
    legs.push(next);
    prev = next;
  }
  return legs;
}

export interface FdpStatus {
  usedMin: number;
  remainingPlannedMin: number;
  remainingMin: number;
  projectedEndMinute?: number;
}

/** FDP arithmetic for a crew member at `simMinute`. */
export function computeFdp(state: SystemState, member: CrewMember, simMinute: number): FdpStatus {
  const report = stateMinuteOf(state, member.reportTime) ?? 0;
  const onDuty = member.status === 'operating' || member.status === 'assigned';
  const usedMin = onDuty ? Math.max(0, simMinute - report) : 0;
  let remainingPlannedMin = 0;
  let projectedEndMinute: number | undefined;
  if (onDuty) {
    const legs = pairing(state, member).filter((f) => f.status !== 'cancelled');
    const pending = legs.filter((f) => isActive(f) || f.status === 'departed');
    const last = pending[pending.length - 1];
    if (last) {
      projectedEndMinute = etaMin(state, last);
      remainingPlannedMin = Math.max(0, projectedEndMinute - Math.max(simMinute, report));
    }
  }
  return {
    usedMin: Math.round(usedMin),
    remainingPlannedMin: Math.round(remainingPlannedMin),
    remainingMin: Math.round(member.maxFdpMin - usedMin - remainingPlannedMin),
    projectedEndMinute,
  };
}

export function seedCrew(scenario: Scenario): SystemStateOf<'crew'> {
  const occ = seedOcc(scenario);
  const state = { ...emptySystemState(), occ } as SystemState;
  const tailLegs = Object.values(occ.flights)
    .filter((f) => f.tail === scenario.aircraft.tail && f.status !== 'departed')
    .sort((a, b) => (a.stdMinute ?? 0) - (b.stdMinute ?? 0));
  const firstLeg = tailLegs[0]?.flight;
  const crew: Record<string, CrewMember> = {};
  for (const c of scenario.world.crew) {
    const m: CrewMember = {
      id: c.id,
      name: c.name,
      rank: c.rank,
      status: c.status,
      station: c.station,
      reportTime: c.reportTime,
      sectorsPlanned: c.sectorsPlanned,
      maxFdpMin: c.maxFdpMin,
      fdpUsedMin: 0,
      fdpRemainingMin: c.maxFdpMin,
    };
    if (c.status === 'operating' && firstLeg) m.assignedFlight = firstLeg;
    const fdp = computeFdp(state, m, 0);
    m.fdpUsedMin = fdp.usedMin;
    m.fdpRemainingMin = fdp.remainingMin;
    crew[c.id] = m;
  }
  return { crew };
}

/** Software may never extend an FDP beyond its maximum. Always refused, with the reason. */
export function requestFdpExtension(state: SystemState, crewId: string, minutes: number): Result<never> {
  const m = state.crew.crew[crewId];
  if (!m) return fail(`unknown crew member ${crewId}`);
  return fail(
    `FDP extension of ${minutes} min for ${crewId} refused: the maximum FDP (${m.maxFdpMin} min) cannot be exceeded by software. ` +
      "Commander's discretion (ORO.FTL.205(f)) is a human decision; use a standby crew or record it for the commander via a discretion report.",
  );
}

/** Assign a standby crew member to replace an operating one from `flight` onwards. */
export function assignStandby(
  state: SystemState,
  input: { standbyId: string; replacesCrewId: string; flight: string },
  simMinute: number,
): Result<{ assigned: CrewMember; replaced: CrewMember; requiredFdpMin: number }> {
  const sby = state.crew.crew[input.standbyId];
  const old = state.crew.crew[input.replacesCrewId];
  const flight = state.occ.flights[input.flight];
  if (!sby) return fail(`unknown crew member ${input.standbyId}`);
  if (!old) return fail(`unknown crew member ${input.replacesCrewId}`);
  if (!flight) return fail(`unknown flight ${input.flight}`);
  if (sby.status !== 'standby') return fail(`${sby.id} is ${sby.status}, not on standby`);
  if (sby.rank !== old.rank) return fail(`rank mismatch: ${sby.id} is ${sby.rank}, ${old.id} is ${old.rank}`);
  if (sby.station !== flight.from)
    return fail(`${sby.id} is at ${sby.station}, but ${flight.flight} departs ${flight.from}`);
  if (!isActive(flight)) return fail(`${flight.flight} is ${flight.status}`);
  // The replaced member's remaining legs from `flight` onwards.
  const legs = pairing(state, old);
  const from = legs.findIndex((f) => f.flight === flight.flight);
  const remaining = (from >= 0 ? legs.slice(from) : [flight]).filter((f) => f.status !== 'cancelled');
  const last = remaining[remaining.length - 1];
  const reportMinute = simMinute; // called out now
  const requiredFdpMin = Math.round(etaMin(state, last) - reportMinute);
  if (requiredFdpMin > sby.maxFdpMin)
    return fail(
      `${sby.id} lacks FDP: ${requiredFdpMin} min needed for ${remaining.length} sector(s), max ${sby.maxFdpMin} min`,
    );
  const reportTime = stateIsoAt(state, reportMinute) ?? sby.reportTime;
  const assignedPatch: Partial<CrewMember> = {
    status: 'assigned',
    assignedFlight: flight.flight,
    reportTime,
    sectorsPlanned: remaining.length,
    fdpUsedMin: 0,
    fdpRemainingMin: sby.maxFdpMin - requiredFdpMin,
  };
  const m1 = updated('crew', 'crew', sby.id, sby, assignedPatch);
  const m2 = updated('crew', 'crew', old.id, old, { status: 'off', assignedFlight: undefined });
  return {
    ok: true,
    value: { assigned: m1.after as CrewMember, replaced: m2.after as CrewMember, requiredFdpMin },
    mutations: [m1, m2],
  };
}

/** FDP burn: persist used/remaining when either moves by ≥ 5 minutes (or remaining changes sign). */
export function tickCrew(state: SystemState, simMinute: number, _dtMin: number): SystemMutation[] {
  const out: SystemMutation[] = [];
  if (originMs(state) === undefined) return out;
  for (const m of Object.values(state.crew.crew)) {
    if (m.status !== 'operating' && m.status !== 'assigned') continue;
    const f = computeFdp(state, m, simMinute);
    const signFlip =
      Math.sign(f.remainingMin) !== Math.sign(m.fdpRemainingMin) && f.remainingMin !== m.fdpRemainingMin;
    if (
      Math.abs(f.usedMin - m.fdpUsedMin) >= 5 ||
      Math.abs(f.remainingMin - m.fdpRemainingMin) >= 5 ||
      signFlip
    )
      out.push(updated('crew', 'crew', m.id, m, { fdpUsedMin: f.usedMin, fdpRemainingMin: f.remainingMin }));
  }
  return out;
}

export const crew: MockSystem<'crew'> = {
  name: 'crew',
  seed: (scenario) => seedCrew(scenario),
  tick: tickCrew,
  knownRefs: (state) => ({ crew: Object.keys(state.crew.crew) }),
};
