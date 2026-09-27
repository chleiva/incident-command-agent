/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import type { CrewMember, SystemState, ToolDefinition } from '@ica/schema';
import { assignStandby, computeFdp, pairing } from '../systems/crew/index';
import { S, err, obj, ok } from './_shared';

function candidatesFor(state: SystemState, replacesCrewId: string, flight: string, simMinute: number) {
  const standbys = Object.values(state.crew.crew).filter((m) => m.status === 'standby');
  const candidates = standbys.map((s) => {
    const r = assignStandby(state, { standbyId: s.id, replacesCrewId, flight }, simMinute);
    return r.ok
      ? {
          id: s.id,
          name: s.name,
          rank: s.rank,
          station: s.station,
          feasible: true,
          requiredFdpMin: r.value.requiredFdpMin,
          maxFdpMin: s.maxFdpMin,
        }
      : { id: s.id, name: s.name, rank: s.rank, station: s.station, feasible: false, reason: r.error };
  });
  return { candidates, feasibleCount: candidates.filter((c) => c.feasible).length };
}

export const find_standby_crew: ToolDefinition<{ replacesCrewId?: string; flight?: string }> = {
  name: 'find_standby_crew',
  description:
    'Standby crew check. With replacesCrewId + flight: every standby checked for replacing that crew member on that flight (matching rank, at the departure station, enough FDP for the remaining sectors if called out now), feasible candidates with the FDP they need, reasons for the others. WITHOUT replacesCrewId (optionally with flight): in ONE call, every on-duty crew member whose FDP margin is negative (on that flight, or anywhere) with the standby candidates for each, plus the standby roster. Use before assign_standby_crew.',
  inputSchema: obj({ replacesCrewId: S.id, flight: S.flight }),
  tier: 'execute',
  system: 'crew',
  roles: ['flightops'],
  mutates: false,
  refs: [
    { path: '/replacesCrewId', kind: 'crew' },
    { path: '/flight', kind: 'flight' },
  ],
  async handler(input, ctx) {
    const { state, simMinute } = ctx;
    if (input.replacesCrewId) {
      const old = state.crew.crew[input.replacesCrewId];
      if (!old) return err(`unknown crew member ${input.replacesCrewId}`);
      const flight = input.flight ?? old.assignedFlight;
      if (!flight)
        return err(`${input.replacesCrewId} has no assigned flight: give the flight to replace them on`);
      return ok(candidatesFor(state, input.replacesCrewId, flight, simMinute));
    }
    const onDuty = Object.values(state.crew.crew).filter(
      (m): m is CrewMember => m.status === 'operating' || m.status === 'assigned',
    );
    const atRisk = onDuty
      .map((m) => ({
        m,
        f: computeFdp(state, m, simMinute),
        sectors: pairing(state, m).map((x) => x.flight),
      }))
      .filter((x) => x.f.remainingMin < 0 && (!input.flight || x.sectors.includes(input.flight)));
    const replacements = atRisk.map(({ m, f, sectors }) => {
      const flight = input.flight ?? sectors[0] ?? m.assignedFlight ?? '';
      return {
        replacesCrewId: m.id,
        name: m.name,
        rank: m.rank,
        fdpMarginMin: f.remainingMin,
        flight,
        ...(flight ? candidatesFor(state, m.id, flight, simMinute) : { candidates: [], feasibleCount: 0 }),
      };
    });
    const standby = Object.values(state.crew.crew)
      .filter((m) => m.status === 'standby')
      .map((m) => ({ id: m.id, name: m.name, rank: m.rank, station: m.station, maxFdpMin: m.maxFdpMin }));
    return ok({
      ...(input.flight ? { flight: input.flight } : {}),
      replacements,
      standby,
      note: replacements.length
        ? 'Every at-risk crew member with their standby candidates, in one result.'
        : 'No on-duty crew member has a negative FDP margin right now; no replacement is needed.',
    });
  },
};
