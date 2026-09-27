/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ToolDefinition } from '@ica/schema';
import { createWorkOrder } from '../systems/mne/index';
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

/**
 * Task 07 (execute): open the overweight-landing inspection work order at the arrival station. Planning only: the
 * decision to land overweight is the commander's, and the aircraft's release after the inspection is certifying
 * staff's.
 */
export const plan_overweight_landing_inspection: ToolDefinition<{
  tail: string;
  requestId: string;
  station?: string;
  engineerId?: string;
  estimatedDurationMin?: number;
}> = {
  name: 'plan_overweight_landing_inspection',
  description:
    "Open the overweight-landing inspection work order for a tail at its arrival station, optionally assigned to an engineer. Planning only: landing overweight is the commander's decision and release after the inspection is certifying staff's.",
  inputSchema: obj(
    {
      tail: S.tail,
      station: S.station,
      engineerId: S.id,
      estimatedDurationMin: { type: 'integer', minimum: 30, maximum: 480 },
      requestId: S.requestId,
    },
    ['tail', 'requestId'],
  ),
  tier: 'execute',
  system: 'mne',
  roles: ['maintenance'],
  mutates: true,
  idempotencyKey: REQUEST_ID_KEY,
  refs: [
    { path: '/tail', kind: 'tail' },
    { path: '/engineerId', kind: 'engineer' },
  ],
  async handler(input, ctx) {
    const [prior] = byRequestId(ctx.state.mne.workOrders, input.requestId);
    if (prior) return replayed({ workOrder: prior });
    const station = input.station ?? incidentStation(ctx);
    const r = createWorkOrder(
      ctx.state,
      {
        tail: input.tail,
        task: `Overweight landing inspection at ${station} (certifying staff decide on release)`,
        estimatedDurationMin: input.estimatedDurationMin ?? 150,
        ...(input.engineerId ? { engineerId: input.engineerId } : {}),
      },
      ctx.simMinute,
      ctx.rng,
    );
    return fromResult(
      r.ok ? { ...r, mutations: tagRequest(r.mutations, 'mne', 'workOrders', input.requestId) } : r,
      (wo) => ({ workOrder: { ...wo, requestId: input.requestId }, station }),
    );
  },
};
