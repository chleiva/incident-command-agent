/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ToolDefinition } from '@ica/schema';
import { pageEngineer } from '../systems/engineers/index';
import { assignWorkOrder } from '../systems/mne/index';
import { applyMutations } from '../systems/util';
import { REQUEST_ID_KEY, S, byRequestId, err, obj, ok, replayed, tagRequest } from './_shared';

export const page_engineer: ToolDefinition<{
  engineerId: string;
  station: string;
  requestId: string;
  workOrderId?: string;
}> = {
  name: 'page_engineer',
  description:
    'Page an available engineer to a station. The system picks the fastest travel mode (walk on airport, drive, or positioning flight) and returns the ETA in sim minutes. Optionally assign a work order to them. Check licences/skills first (a B1 for mechanical/structural, B2 for avionics).',
  inputSchema: obj({ engineerId: S.id, station: S.station, workOrderId: S.id, requestId: S.requestId }, [
    'engineerId',
    'station',
    'requestId',
  ]),
  tier: 'execute',
  system: 'engineers',
  roles: ['maintenance'],
  mutates: true,
  idempotencyKey: REQUEST_ID_KEY,
  refs: [
    { path: '/engineerId', kind: 'engineer' },
    { path: '/station', kind: 'station' },
    { path: '/workOrderId', kind: 'workOrder' },
  ],
  async handler(input, ctx) {
    // Idempotent: a repeat requestId returns the original page (ETA) instead of failing "already paged".
    const [prior] = byRequestId(ctx.state.engineers.engineers, input.requestId, 'pageRequestId');
    if (prior)
      return replayed({
        engineerId: prior.id,
        name: prior.name,
        licence: prior.licence,
        status: prior.status,
        travel: prior.travelMode,
        etaMinute: prior.etaMinute,
        ...(input.workOrderId ? { workOrderId: input.workOrderId } : {}),
      });
    const r = pageEngineer(ctx.state, ctx.scenario, input, ctx.simMinute, ctx.rng);
    if (!r.ok) return err(r.error);
    const mutations = tagRequest(r.mutations, 'engineers', 'engineers', input.requestId, 'pageRequestId', [
      'update',
    ]);
    if (input.workOrderId) {
      const a = assignWorkOrder(applyMutations(ctx.state, mutations), input.workOrderId, input.engineerId);
      if (!a.ok) return err(a.error);
      mutations.push(...a.mutations);
    }
    const { engineer, plan } = r.value;
    return ok(
      {
        engineerId: engineer.id,
        name: engineer.name,
        licence: engineer.licence,
        status: engineer.status,
        travel: plan.mode,
        etaMinute: plan.etaMinute,
        detail: plan.detail,
        ...(input.workOrderId ? { workOrderId: input.workOrderId } : {}),
      },
      mutations,
    );
  },
};
