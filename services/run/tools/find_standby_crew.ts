/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ToolDefinition } from '@ica/schema';
import { assignStandby } from '../systems/crew/index';
import { S, err, obj, ok } from './_shared';

export const find_standby_crew: ToolDefinition<{ replacesCrewId: string; flight: string }> = {
  name: 'find_standby_crew',
  description:
    'For a crew member who must be replaced from a given flight, check every standby: matching rank, at the departure station, and enough FDP for the remaining sectors if called out now. Returns feasible candidates with the FDP they would need, and reasons for the others. Use before assign_standby_crew.',
  inputSchema: obj({ replacesCrewId: S.id, flight: S.flight }, ['replacesCrewId', 'flight']),
  tier: 'execute',
  system: 'crew',
  roles: ['flightops'],
  mutates: false,
  refs: [
    { path: '/replacesCrewId', kind: 'crew' },
    { path: '/flight', kind: 'flight' },
  ],
  async handler(input, ctx) {
    if (!ctx.state.crew.crew[input.replacesCrewId]) return err(`unknown crew member ${input.replacesCrewId}`);
    const standbys = Object.values(ctx.state.crew.crew).filter((m) => m.status === 'standby');
    const candidates = standbys.map((s) => {
      const r = assignStandby(
        ctx.state,
        { standbyId: s.id, replacesCrewId: input.replacesCrewId, flight: input.flight },
        ctx.simMinute,
      );
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
    return ok({ candidates, feasibleCount: candidates.filter((c) => c.feasible).length });
  },
};
