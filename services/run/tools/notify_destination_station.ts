/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import { getStation } from '@ica/kb';
import type { ToolDefinition } from '@ica/schema';
import { createHandlerTask } from '../systems/handler/index';
import { REQUEST_ID_KEY, S, byRequestId, err, fromResult, obj, replayed, tagRequest } from './_shared';

/**
 * Task 07 (execute, idempotent): tell a station that a flight will not arrive as planned (diversion or turnback), so
 * it can stand down or re-plan its turnaround, gate and passengers waiting to board.
 */
export const notify_destination_station: ToolDefinition<{
  station: string;
  flight: string;
  requestId: string;
}> = {
  name: 'notify_destination_station',
  description:
    'Inform a station (usually the planned destination) that a flight will not arrive as planned, so it can stand down the turnaround and look after passengers waiting for the return. Informational; idempotent by requestId. It does not decide anything about the flight.',
  inputSchema: obj(
    {
      station: S.station,
      flight: S.flight,
      requestId: S.requestId,
    },
    ['station', 'flight', 'requestId'],
  ),
  tier: 'execute',
  system: 'handler',
  roles: ['ground', 'flightops'],
  mutates: true,
  idempotencyKey: REQUEST_ID_KEY,
  refs: [{ path: '/flight', kind: 'flight' }],
  async handler(input, ctx) {
    if (!getStation(input.station)) return err(`unknown station ${input.station}`);
    const [prior] = byRequestId(ctx.state.handler.tasks, input.requestId);
    if (prior) return replayed({ notification: prior });
    const r = createHandlerTask(
      ctx.state,
      { station: input.station, kind: 'station_notification', priority: 'urgent' },
      ctx.simMinute,
      1,
      ctx.rng,
    );
    return fromResult(
      r.ok ? { ...r, mutations: tagRequest(r.mutations, 'handler', 'tasks', input.requestId) } : r,
      (task) => ({
        notification: {
          ...task,
          requestId: input.requestId,
          flight: input.flight,
        },
      }),
    );
  },
};
