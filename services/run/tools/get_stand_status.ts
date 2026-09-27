/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ToolDefinition } from '@ica/schema';
import { engineerStatus } from './_engineers';
import { S, incidentStation, obj, ok } from './_shared';

export const get_stand_status: ToolDefinition<{ station?: string }> = {
  name: 'get_stand_status',
  description:
    'Airport picture at a station (default: the incident station): stands with occupancy, pending/confirmed stand requests, tows/buses/stairs/fire-service requests with ETAs, handler equipment available, handler tasks, and the engineer coming to the aircraft (the same responding engineer maintenance sees, with ETA).',
  inputSchema: obj({ station: S.station }),
  tier: 'execute',
  system: 'airport',
  roles: ['ground'],
  mutates: false,
  refs: [{ path: '/station', kind: 'station' }],
  async handler(input, ctx) {
    const station = input.station ?? incidentStation(ctx);
    const a = ctx.state.airport;
    return ok({
      station,
      simMinute: ctx.simMinute,
      stands: Object.values(a.stands)
        .filter((s) => s.station === station)
        .map((s) => ({
          ...s,
          free:
            !s.occupiedByTail ||
            (s.occupiedUntilMinute !== undefined && s.occupiedUntilMinute <= ctx.simMinute),
        })),
      standRequests: Object.values(a.standRequests),
      resourceRequests: Object.values(a.resourceRequests).filter((r) => r.station === station),
      equipment: Object.values(ctx.state.handler.equipment).filter((e) => e.station === station),
      handlerTasks: Object.values(ctx.state.handler.tasks).filter((t) => t.station === station),
      respondingEngineer: engineerStatus(ctx).responding,
    });
  },
};
