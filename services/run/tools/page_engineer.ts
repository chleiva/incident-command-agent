/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Engineer, SystemMutation, ToolContext, ToolDefinition, ToolOutcome } from '@ica/schema';
import { activeEngineers, pageEngineer, travelPlan } from '../systems/engineers/index';
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

/** Longest page reason kept (a model's reason is often a full sentence; demo review 2 raised 60 → 500). */
export const PAGE_REASON_MAX = 500;

/** Why an engineer suits the job, in plain words (licence scope + where they are). */
function suitability(e: Engineer, station: string): string {
  const scope =
    e.licence === 'B1'
      ? 'B1: mechanical and structural'
      : e.licence === 'B2'
        ? 'B2: avionics and electrical'
        : `${e.licence}`;
  const skills = e.skills.filter((k) => !/family$/i.test(k) && !/^A3\d\d/.test(k));
  const where = e.location === station ? `already at ${station}` : `based at ${e.station}`;
  return `${scope}${skills.length ? ` (${skills.join(', ')})` : ''}; ${where}`;
}

export interface EngineerAlternative {
  engineerId: string;
  name: string;
  licence: string;
  station: string;
  /** Pageable now (else: busy until `availableFromMinute`). */
  availableNow: boolean;
  availableFromMinute?: number;
  travel: 'walk' | 'drive' | 'fly';
  /** Estimated arrival at the station if paged now (or as soon as they are free); the real page returns the ETA. */
  etaMinuteEstimate: number;
  whySuitable: string;
}

/**
 * The engineers who could go instead of `excludeId`, fastest first: available ones now, busy ones from when they are
 * free. ETAs are estimates with a fixed draw (the run's seeded RNG is not consumed by a suggestion).
 */
export function engineerAlternatives(
  ctx: Pick<ToolContext, 'state' | 'scenario' | 'simMinute'>,
  station: string,
  excludeId?: string,
): EngineerAlternative[] {
  const fixed = () => 0.5;
  return Object.values(ctx.state.engineers.engineers)
    .filter((e) => e.id !== excludeId && (e.status === 'available' || e.status === 'busy'))
    .map((e): EngineerAlternative => {
      const from =
        e.status === 'busy' ? Math.max(ctx.simMinute, e.availableFromMinute ?? ctx.simMinute) : ctx.simMinute;
      const plan = travelPlan(ctx.scenario, e.location, station, from, fixed);
      return {
        engineerId: e.id,
        name: e.name,
        licence: e.licence,
        station: e.location,
        availableNow: e.status === 'available',
        ...(e.status === 'busy' && e.availableFromMinute !== undefined
          ? { availableFromMinute: e.availableFromMinute }
          : {}),
        travel: plan.mode,
        etaMinuteEstimate: Math.round(plan.etaMinute),
        whySuitable: suitability(e, station),
      };
    })
    .sort(
      (a, b) => Number(b.availableNow) - Number(a.availableNow) || a.etaMinuteEstimate - b.etaMinuteEstimate,
    )
    .slice(0, 5);
}

type Unavailable = { kind: 'busy' | 'unknown'; untilMinute?: number };

function unavailability(e: Engineer | undefined): Unavailable | null {
  if (!e) return { kind: 'unknown' };
  if (e.status === 'busy')
    return {
      kind: 'busy',
      ...(e.availableFromMinute !== undefined ? { untilMinute: e.availableFromMinute } : {}),
    };
  return null;
}

/** A page that could not be sent: plain reason + the alternatives, as structured data (no mutation). */
function cannotPage(
  ctx: ToolContext,
  input: { engineerId: string; station: string },
  e: Engineer | undefined,
  why: Unavailable,
  retry?: { atMinute: number },
): ToolOutcome<never> {
  const alternatives = engineerAlternatives(ctx, input.station, input.engineerId);
  const who = e ? `${e.name} (${e.id})` : `Engineer ${input.engineerId}`;
  const reason =
    why.kind === 'busy'
      ? `is busy${why.untilMinute !== undefined ? ` until minute ${Math.round(why.untilMinute)}` : ''}`
      : 'is not on the roster';
  const next = alternatives.length
    ? 'Page one of the alternatives below instead (fastest first); do not retry this engineer.'
    : 'No other engineer is available: report this as an open issue.';
  const error = retry
    ? `Not sent again: ${who} was already tried at minute ${Math.round(retry.atMinute)} and still ${reason}. Nothing changed. ${next}`
    : `${who} ${reason}; nothing was sent. ${next}`;
  return {
    ok: false,
    error,
    data: {
      notPaged: true,
      engineerId: input.engineerId,
      ...(e ? { name: e.name, licence: e.licence } : {}),
      reason: why.kind,
      ...(why.untilMinute !== undefined ? { busyUntilMinute: why.untilMinute } : {}),
      ...(retry ? { retryRefused: true } : {}),
      alternatives,
    },
  };
}

export const page_engineer: ToolDefinition<{
  engineerId: string;
  station: string;
  requestId: string;
  workOrderId?: string;
  reason?: string;
}> = {
  name: 'page_engineer',
  description:
    'Page an available engineer to a station ONCE. The system picks the fastest travel mode (walk on airport, drive, or positioning flight) and returns the ETA in sim minutes. Paging an engineer who is already paged, travelling or on site sends nothing new: it returns their current status and ETA (follow them with get_aircraft_status, do not re-page). Paging a SECOND engineer while one is already on the way needs a `reason` (e.g. "backup", "B2 needed for avionics"), which is recorded. With workOrderId the engineer is assigned to that work order (a work order has exactly one assigned engineer; an existing assignment is kept and returned). Check licences/skills first (a B1 for mechanical/structural, B2 for avionics). If the engineer cannot be paged (busy, not on the roster) nothing is sent and the result lists the available alternatives with licence, station and estimated ETA: page one of them, never the same engineer again.',
  inputSchema: obj(
    {
      engineerId: S.id,
      station: S.station,
      workOrderId: S.id,
      requestId: S.requestId,
      reason: {
        type: 'string',
        minLength: 2,
        maxLength: PAGE_REASON_MAX,
        description:
          'Why a second engineer is needed while another is already on the way (e.g. "backup: the first ETA is too late").',
      },
    },
    ['engineerId', 'station', 'requestId'],
  ),
  tier: 'execute',
  system: 'engineers',
  roles: ['maintenance'],
  mutates: true,
  // The reason is free text recorded on the engineer (shown in the cockpit): screened like a report.
  outputScreen: { kind: 'report', fields: ['/reason'] },
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
    // Unavailable (busy / not on the roster): nothing is sent; the result lists who could go instead. An immediate
    // retry of the same unavailable engineer (this agent's last page failed for them) is refused explicitly.
    const why = unavailability(e);
    if (why) {
      // The last page this agent actually attempted (calls refused by arg validation never reached the system).
      const last = (ctx.priorCalls?.('page_engineer') ?? [])
        .filter((c) => c.ok || (c.result as { notPaged?: unknown } | undefined)?.notPaged === true)
        .at(-1);
      const retry =
        last && !last.ok && last.args.engineerId === input.engineerId
          ? { atMinute: last.atMinute }
          : undefined;
      return cannotPage(ctx, input, e, why, retry);
    }
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
