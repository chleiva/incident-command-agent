/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ToolDefinition } from '@ica/schema';
import { createWorkOrder } from '../systems/mne/index';
import { REQUEST_ID_KEY, S, byRequestId, fromResult, obj, replayed, tagRequest } from './_shared';

export const WORK_ORDER_TASKS = {
  damage_assessment: 'Damage assessment',
  bird_strike_inspection: 'Bird strike inspection',
  lightning_strike_inspection: 'Lightning strike inspection',
  borescope_inspection: 'Engine borescope inspection',
  door_inspection_and_rigging_check: 'Door inspection and rigging check',
  sensor_troubleshooting: 'Sensor / indication troubleshooting',
  apu_troubleshooting: 'APU troubleshooting',
  hydraulic_leak_check: 'Hydraulic leak check and rectification',
  brake_cooling_and_inspection: 'Brake cooling and inspection',
  slide_reinstatement: 'Escape slide reinstatement / replacement',
  fuel_leak_inspection: 'Fuel system leak inspection',
  structural_repair_assessment: 'Structural repair assessment',
  component_replacement: 'Component replacement',
  general_visual_inspection: 'General visual inspection',
} as const;
type Task = keyof typeof WORK_ORDER_TASKS;

export const create_work_order: ToolDefinition<{
  tail: string;
  task: Task;
  estimatedDurationMin: number;
  requestId: string;
  defectId?: string;
  engineerId?: string;
}> = {
  name: 'create_work_order',
  description:
    'Open a maintenance work order for a tail (optionally linked to a defect and assigned to an engineer). It progresses automatically once the assigned engineer is on site, and ends awaiting certification by a certifying engineer. Returns the work order id.',
  inputSchema: obj(
    {
      tail: S.tail,
      task: { type: 'string', enum: Object.keys(WORK_ORDER_TASKS) },
      estimatedDurationMin: { type: 'integer', minimum: 5, maximum: 720 },
      defectId: S.id,
      engineerId: S.id,
      requestId: S.requestId,
    },
    ['tail', 'task', 'estimatedDurationMin', 'requestId'],
  ),
  tier: 'execute',
  system: 'mne',
  roles: ['maintenance'],
  mutates: true,
  idempotencyKey: REQUEST_ID_KEY,
  refs: [
    { path: '/tail', kind: 'tail' },
    { path: '/defectId', kind: 'defect' },
    { path: '/engineerId', kind: 'engineer' },
  ],
  async handler(input, ctx) {
    // Idempotent: a repeat requestId returns the work order it created, with no new mutation.
    const [prior] = byRequestId(ctx.state.mne.workOrders, input.requestId);
    if (prior) return replayed({ workOrder: prior });
    const task = `${WORK_ORDER_TASKS[input.task]}${input.defectId ? ` (${input.defectId})` : ''}`;
    const { requestId, ...rest } = input;
    const r = createWorkOrder(ctx.state, { ...rest, task }, ctx.simMinute, ctx.rng);
    return fromResult(
      r.ok ? { ...r, mutations: tagRequest(r.mutations, 'mne', 'workOrders', requestId) } : r,
      (wo) => ({ workOrder: { ...wo, requestId } }),
    );
  },
};
