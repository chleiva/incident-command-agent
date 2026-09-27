/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Engineer, SystemMutation, ToolDefinition } from '@ica/schema';
import { activeEngineers, pageEngineer } from '../systems/engineers/index';
import { assignWorkOrder } from '../systems/mne/index';
import { applyMutations } from '../systems/util';
import { REQUEST_ID_KEY, S, byRequestId, err, obj, ok, replayed, tagRequest } from './_shared';

const statusOf = (e: Engineer) => ({
  engineerId: e.id,
  name: e.name,
  licence: e.licence,
  status: e.status,
  ...(e.destination ? { destination: e.destination } : {}),
  ...(e.travelMode ? { travel: e.travelMode } : {}),
  ...(e.etaMinute !== undefined ? { etaMinute: e.etaMinute } : {}),
  ...(e.workOrderId ? { workOrderId: e.workOrderId } : {}),
  ...(e.pageReason ? { pageReason: e.pageReason } : {}),
});

export const page_engineer: ToolDefinition<{
  engineerId: string;
  station: string;
  requestId: string;
  workOrderId?: string;
  reason?: string;
}> = {
  name: 'page_engineer',
  description:
    'Page an available engineer to a station ONCE. The system picks the fastest travel mode (walk on airport, drive, or positioning flight) and returns the ETA in sim minutes. Paging an engineer who is already paged, travelling or on site sends nothing new: it returns their current status and ETA (follow them with get_aircraft_status, do not re-page). Paging a SECOND engineer while one is already on the way needs a `reason` (e.g. "backup", "B2 needed for avionics"), which is recorded. With workOrderId the engineer is assigned to that work order (a work order has exactly one assigned engineer; an existing assignment is kept and returned). Check licences/skills first (a B1 for mechanical/structural, B2 for avionics).',
  inputSchema: obj(
    {
      engineerId: S.id,
      station: S.station,
      workOrderId: S.id,
      requestId: S.requestId,
      reason: {
        type: 'string',
        minLength: 2,
        maxLength: 60,
        description: 'Why a second engineer is needed while another is already on the way (e.g. "backup").',
      },
    },
    ['engineerId', 'station', 'requestId'],
  ),
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
        ...statusOf(prior),
        ...(input.workOrderId ? { workOrderId: input.workOrderId } : {}),
      });
    const e = ctx.state.engineers.engineers[input.engineerId];
    if (!e) return err(`unknown engineer ${input.engineerId}`);
    const wo = input.workOrderId ? ctx.state.mne.workOrders[input.workOrderId] : undefined;
    if (input.workOrderId && !wo) return err(`unknown work order ${input.workOrderId}`);

    // Work-order assignment: exactly one engineer per work order; an existing assignment is kept.
    const assignment = (
      state = ctx.state,
    ): { mutations: SystemMutation[]; info?: Record<string, unknown> } => {
      if (!wo) return { mutations: [] };
      if (wo.assignedEngineerId && wo.assignedEngineerId !== input.engineerId)
        return {
          mutations: [],
          info: {
            workOrderId: wo.id,
            assignedEngineerId: wo.assignedEngineerId,
            assignmentNote: `${wo.id} is already assigned to ${wo.assignedEngineerId}; the assignment was kept.`,
          },
        };
      if (wo.assignedEngineerId === input.engineerId)
        return { mutations: [], info: { workOrderId: wo.id, assignedEngineerId: input.engineerId } };
      const a = assignWorkOrder(state, wo.id, input.engineerId);
      return a.ok
        ? { mutations: a.mutations, info: { workOrderId: wo.id, assignedEngineerId: input.engineerId } }
        : { mutations: [], info: { workOrderId: wo.id, assignmentNote: a.error } };
    };

    // Already paged / travelling / on site: no new page, no new mutation of the engineer.
    if (e.status === 'paged' || e.status === 'travelling' || e.status === 'on_site') {
      const a = assignment();
      return ok(
        {
          alreadyPaged: true,
          ...statusOf(e),
          ...(a.info ?? {}),
          note: `${e.name} is already ${e.status}${e.destination ? ` to ${e.destination}` : ''}${e.etaMinute !== undefined && e.status !== 'on_site' ? `, ETA minute ${Math.round(e.etaMinute)}` : ''}. Nothing was sent again: follow them with get_aircraft_status (engineers.responding).`,
        },
        a.mutations,
      );
    }

    // A second engineer while another is on the way: only with a stated reason (recorded on the page).
    const others = activeEngineers(ctx.state).filter((x) => x.id !== e.id);
    // A person (baseline chronology) may page a second engineer without typing a reason; it is still recorded.
    const reason =
      input.reason?.trim() ||
      (ctx.actor.kind === 'human' && others.length
        ? `additional engineer (${ctx.actor.roleTitle})`
        : undefined);
    if (others.length && !reason) {
      const o = others[0]!;
      return err(
        `${o.name} (${o.id}) is already ${o.status}${o.destination ? ` to ${o.destination}` : ''}${o.etaMinute !== undefined && o.status !== 'on_site' ? `, ETA minute ${Math.round(o.etaMinute)}` : ''}. Follow them with get_aircraft_status instead of re-paging. To page a second engineer anyway, call again with a reason (e.g. "backup", "B2 needed for avionics").`,
      );
    }
    const assignsWo = wo && (!wo.assignedEngineerId || wo.assignedEngineerId === e.id) ? wo.id : undefined;
    const r = pageEngineer(
      ctx.state,
      ctx.scenario,
      {
        engineerId: input.engineerId,
        station: input.station,
        ...(others.length && reason ? { reason } : {}),
        ...(assignsWo ? { workOrderId: assignsWo } : {}),
      },
      ctx.simMinute,
      ctx.rng,
    );
    if (!r.ok) return err(r.error);
    const mutations = tagRequest(r.mutations, 'engineers', 'engineers', input.requestId, 'pageRequestId', [
      'update',
    ]).map((m) =>
      // tagRequest tags every engineer update; only the paged engineer carries this page's request id
      m.id === input.engineerId ? m : r.mutations.find((x) => x.id === m.id)!,
    );
    const a = assignment(applyMutations(ctx.state, mutations));
    mutations.push(...a.mutations);
    const { engineer, plan, delayedByMin } = r.value;
    return ok(
      {
        ...statusOf(engineer),
        travel: plan.mode,
        etaMinute: plan.etaMinute,
        detail: plan.detail,
        ...(delayedByMin ? { delayedByMin } : {}),
        ...(a.info ?? {}),
        ...(others.length
          ? {
              alsoOnTheWay: others.map((o) => ({
                engineerId: o.id,
                status: o.status,
                etaMinute: o.etaMinute,
              })),
            }
          : {}),
      },
      mutations,
    );
  },
};
