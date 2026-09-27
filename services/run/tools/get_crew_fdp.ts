/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ToolDefinition } from '@ica/schema';
import { computeFdp, pairing } from '../systems/crew/index';
import { S, err, obj, ok } from './_shared';

export const get_crew_fdp: ToolDefinition<{ crewId?: string }> = {
  name: 'get_crew_fdp',
  description:
    'Flight duty period status now, per crew member (or one): report time, FDP used, remaining planned duty to the last sector (including current delays), remaining margin against the maximum, and the sectors still to fly. A negative margin means the plan is illegal without a change.',
  inputSchema: obj({ crewId: S.id }),
  tier: 'execute',
  system: 'crew',
  roles: ['flightops'],
  mutates: false,
  refs: [{ path: '/crewId', kind: 'crew' }],
  async handler(input, ctx) {
    const members = input.crewId ? [ctx.state.crew.crew[input.crewId]] : Object.values(ctx.state.crew.crew);
    if (input.crewId && !members[0]) return err(`unknown crew member ${input.crewId}`);
    return ok({
      simMinute: ctx.simMinute,
      crew: members.map((m) => {
        const f = computeFdp(ctx.state, m, ctx.simMinute);
        return {
          id: m.id,
          name: m.name,
          rank: m.rank,
          status: m.status,
          station: m.station,
          reportTime: m.reportTime,
          maxFdpMin: m.maxFdpMin,
          fdpUsedMin: f.usedMin,
          remainingPlannedMin: f.remainingPlannedMin,
          fdpMarginMin: f.remainingMin,
          sectors: pairing(ctx.state, m).map((x) => x.flight),
          ...(f.remainingMin < 0 ? { warning: 'planned duty exceeds maximum FDP' } : {}),
        };
      }),
    });
  },
};
