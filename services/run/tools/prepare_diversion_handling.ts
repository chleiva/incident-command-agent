/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import { getStation } from '@ica/kb';
import type { HandlerTask, SystemMutation, ToolDefinition } from '@ica/schema';
import { createHandlerTask, type HandlerTaskKind } from '../systems/handler/index';
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

const SERVICES: Record<string, HandlerTaskKind> = {
  handling: 'diversion_handling',
  stairs: 'stairs',
  disembark: 'deboard_passengers',
  fuel: 'refuel',
  catering: 'catering_uplift',
  hotel_hold: 'hotel_hold',
  prm_assistance: 'prm_assistance',
};

/**
 * Task 07 (propose): book the ground side at an airport the aircraft is (or may be) arriving at unscheduled —
 * handling team, steps, disembarkation, fuel, catering, hotel holds. A duty manager approves. It prepares the
 * ground only; the commander chooses the airport.
 */
export const prepare_diversion_handling: ToolDefinition<{
  station: string;
  services: string[];
  requestId: string;
  tail?: string;
}> = {
  name: 'prepare_diversion_handling',
  description:
    "Prepare the ground at an airport for an unscheduled arrival (diversion or turnback): handling team, stairs, disembarkation, fuel, catering and water, hotel holds, PRM assistance. Needs a duty manager's approval. It prepares the ground only; the commander chooses the airport.",
  inputSchema: obj(
    {
      station: S.station,
      services: arrayOf({ type: 'string', enum: Object.keys(SERVICES) }, 7),
      tail: S.tail,
      requestId: S.requestId,
    },
    ['station', 'services', 'requestId'],
  ),
  tier: 'propose',
  system: 'handler',
  roles: ['ground'],
  mutates: true,
  idempotencyKey: REQUEST_ID_KEY,
  approvalScope: 'Booking the listed ground services at the airport shown, for the arriving aircraft.',
  approvalExclusions: [
    'The choice of airport (the commander decides)',
    'Passenger care and rebooking (proposed separately)',
  ],
  defaultUnresolvedChecks: ['The commander has confirmed where the aircraft will land'],
  refs: [{ path: '/tail', kind: 'tail' }],
  async handler(input, ctx) {
    const denied = requireApproval(ctx);
    if (denied) return err(denied);
    if (!getStation(input.station)) return err(`unknown station ${input.station}`);
    const prior = byRequestId(ctx.state.handler.tasks, input.requestId);
    if (prior.length) return replayed({ tasks: prior });
    let s = ctx.state;
    const mutations: SystemMutation[] = [];
    const tasks: HandlerTask[] = [];
    for (const svc of input.services) {
      const r = createHandlerTask(
        s,
        {
          station: input.station,
          kind: SERVICES[svc]!,
          ...(input.tail ? { tail: input.tail } : {}),
          priority: 'urgent',
        },
        ctx.simMinute,
        ctx.scenario.world.handler.ackMinutes,
        ctx.rng,
      );
      if (!r.ok) return err(r.error);
      mutations.push(...r.mutations);
      s = applyMutations(s, r.mutations);
      tasks.push({ ...r.value, requestId: input.requestId });
    }
    return ok(
      { station: input.station, tasks, approvedBy: approverOf(ctx) },
      tagRequest(mutations, 'handler', 'tasks', input.requestId),
    );
  },
};
