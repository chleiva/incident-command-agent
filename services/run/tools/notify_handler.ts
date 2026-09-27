/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import { EQUIPMENT_KINDS, type EquipmentKind, type ToolDefinition } from '@ica/schema';
import { HANDLER_TASK_KINDS, createHandlerTask, type HandlerTaskKind } from '../systems/handler/index';
import {
  REQUEST_ID_KEY,
  S,
  byRequestId,
  fromResult,
  incidentStation,
  obj,
  replayed,
  tagRequest,
} from './_shared';

export const notify_handler: ToolDefinition<{
  kind: HandlerTaskKind;
  requestId: string;
  station?: string;
  tail?: string;
  equipmentKind?: EquipmentKind;
  priority?: 'normal' | 'urgent';
}> = {
  name: 'notify_handler',
  description:
    'Give the ground handler a task (hold boarding, offload bags, stairs, FOD sweep, fuel-spill clean-up, PRM assistance…), optionally reserving one unit of equipment. The handler acknowledges after its response time; returns the task with its acknowledgement minute.',
  inputSchema: obj(
    {
      kind: { type: 'string', enum: [...HANDLER_TASK_KINDS] },
      station: S.station,
      tail: S.tail,
      equipmentKind: { type: 'string', enum: [...EQUIPMENT_KINDS] },
      priority: { type: 'string', enum: ['normal', 'urgent'] },
      requestId: S.requestId,
    },
    ['kind', 'requestId'],
  ),
  tier: 'execute',
  system: 'handler',
  roles: ['ground'],
  mutates: true,
  idempotencyKey: REQUEST_ID_KEY,
  refs: [
    { path: '/station', kind: 'station' },
    { path: '/tail', kind: 'tail' },
  ],
  async handler(input, ctx) {
    // Idempotent: a repeat requestId returns the task it created (the handler is not notified twice).
    const [prior] = byRequestId(ctx.state.handler.tasks, input.requestId);
    if (prior) return replayed({ task: prior });
    const { requestId, ...rest } = input;
    const r = createHandlerTask(
      ctx.state,
      { ...rest, station: rest.station ?? incidentStation(ctx) },
      ctx.simMinute,
      ctx.scenario.world.handler.ackMinutes,
      ctx.rng,
    );
    return fromResult(
      r.ok ? { ...r, mutations: tagRequest(r.mutations, 'handler', 'tasks', requestId) } : r,
      (task) => ({
        task: { ...task, requestId },
      }),
    );
  },
};
