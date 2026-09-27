/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ResourceRequest, SystemMutation, ToolDefinition } from '@ica/schema';
import { requestResource } from '../systems/airport/index';
import { applyMutations } from '../systems/util';
import {
  REQUEST_ID_KEY,
  S,
  byRequestId,
  err,
  incidentStation,
  obj,
  ok,
  replayed,
  tagRequest,
} from './_shared';

export const request_bus: ToolDefinition<{
  requestId: string;
  station?: string;
  count?: number;
  tail?: string;
}> = {
  name: 'request_bus',
  description:
    'Request apron buses (e.g. to disembark passengers from a remote stand or move them to a swap aircraft). Takes buses from the handler pool; returns ETAs. Fails if not enough buses are free.',
  inputSchema: obj(
    {
      station: S.station,
      count: { type: 'integer', minimum: 1, maximum: 4 },
      tail: S.tail,
      requestId: S.requestId,
    },
    ['requestId'],
  ),
  tier: 'execute',
  system: 'airport',
  roles: ['ground'],
  mutates: true,
  idempotencyKey: REQUEST_ID_KEY,
  refs: [
    { path: '/station', kind: 'station' },
    { path: '/tail', kind: 'tail' },
  ],
  async handler(input, ctx) {
    const prior = byRequestId(ctx.state.airport.resourceRequests, input.requestId);
    if (prior.length) return replayed({ buses: prior });
    const station = input.station ?? incidentStation(ctx);
    let s = ctx.state;
    const mutations: SystemMutation[] = [];
    const buses: ResourceRequest[] = [];
    for (let i = 0; i < (input.count ?? 1); i++) {
      const r = requestResource(
        s,
        { kind: 'bus', station, tail: input.tail },
        ctx.simMinute,
        ctx.scenario.world.handler.ackMinutes,
        ctx.rng,
      );
      if (!r.ok) return err(`${r.error}${buses.length ? ` (after ${buses.length} bus(es))` : ''}`);
      mutations.push(...r.mutations);
      s = applyMutations(s, r.mutations);
      buses.push(r.value);
    }
    return ok(
      { buses: buses.map((b) => ({ ...b, requestId: input.requestId })) },
      tagRequest(mutations, 'airport', 'resourceRequests', input.requestId),
    );
  },
};
