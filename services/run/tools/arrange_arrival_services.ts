/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import { getStation } from '@ica/kb';
import type { ResourceRequest, SystemMutation, ToolDefinition } from '@ica/schema';
import { requestResource } from '../systems/airport/index';
import { applyMutations } from '../systems/util';
import {
  REQUEST_ID_KEY,
  S,
  approverOf,
  arrayOf,
  byRequestId,
  err,
  obj,
  ok,
  replayed,
  requireApproval,
  tagRequest,
} from './_shared';

const SERVICES: Record<string, ResourceRequest['kind']> = {
  fire_standby: 'fire_service',
  medical: 'medical',
  police: 'police',
};

/**
 * Task 07 (propose): services to meet an arriving aircraft — rescue and fire-fighting standby, medical team,
 * police. A duty manager approves. (Engineers to meet the aircraft: maintenance pages them.)
 */
export const arrange_arrival_services: ToolDefinition<{
  station: string;
  services: string[];
  requestId: string;
  tail?: string;
}> = {
  name: 'arrange_arrival_services',
  description:
    "Ask the airport for services to meet an arriving aircraft: fire and rescue standby, a medical team, police. Needs a duty manager's approval. (The crew and air traffic control coordinate the emergency itself; this is the airline's ground request.)",
  inputSchema: obj(
    {
      station: S.station,
      services: arrayOf({ type: 'string', enum: Object.keys(SERVICES) }, 3),
      tail: S.tail,
      requestId: S.requestId,
    },
    ['station', 'services', 'requestId'],
  ),
  tier: 'propose',
  system: 'airport',
  roles: ['ground'],
  mutates: true,
  idempotencyKey: REQUEST_ID_KEY,
  approvalScope: 'Requesting the listed arrival services at the airport shown.',
  approvalExclusions: ['Anything the flight crew or air traffic control decide'],
  refs: [{ path: '/tail', kind: 'tail' }],
  async handler(input, ctx) {
    const denied = requireApproval(ctx);
    if (denied) return err(denied);
    if (!getStation(input.station)) return err(`unknown station ${input.station}`);
    const prior = byRequestId(ctx.state.airport.resourceRequests, input.requestId);
    if (prior.length) return replayed({ services: prior });
    let s = ctx.state;
    const mutations: SystemMutation[] = [];
    const out: ResourceRequest[] = [];
    for (const svc of input.services) {
      const r = requestResource(
        s,
        { kind: SERVICES[svc]!, station: input.station, ...(input.tail ? { tail: input.tail } : {}) },
        ctx.simMinute,
        ctx.scenario.world.handler.ackMinutes,
        ctx.rng,
      );
      if (!r.ok) return err(r.error);
      mutations.push(...r.mutations);
      s = applyMutations(s, r.mutations);
      out.push({ ...r.value, requestId: input.requestId });
    }
    return ok(
      { station: input.station, services: out, approvedBy: approverOf(ctx) },
      tagRequest(mutations, 'airport', 'resourceRequests', input.requestId),
    );
  },
};
