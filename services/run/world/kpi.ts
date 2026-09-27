/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * KPI models (spec §8) as pure functions of the world snapshot, the scenario's KPI parameters and the event log.
 * Every KPI carries its formula, inputs and contributing event seqs ("why this number").
 *
 * Conventions (set by the occ system, which owns delays): `delayMin` is a flight's total departure delay against STD
 * and `reactionaryDelayMin` is the part of it that is reactionary (≤ delayMin), so the projected delay is `delayMin`,
 * primary minutes are `delayMin − reactionaryDelayMin`; cancelled flights contribute to the
 * cancellation cost and to EU261 compensation, not to delay cost; minutes are measured from the trigger.
 */
import { FLIGHT_DECK_FORBIDDEN_TOOLS } from '@ica/schema';
import type {
  ComplianceValue,
  Flight,
  Kpi,
  KpiParams,
  KpiSnapshot,
  LatencyValue,
  RunEvent,
  SafetyValue,
  SystemState,
} from '@ica/schema';

export interface WorldSnapshot {
  simMinute: number;
  triggerMinute: number;
  state: SystemState;
  /** Great-circle distance of a flight (km), if known. */
  distanceKm?: (flight: string) => number | null;
  /** Whether both ends of a flight are in the EU (EU261 intra-EU rule). Default false. */
  intraEu?: (flight: string) => boolean;
}

export const THREE_HOURS_MIN = 180;
export const MOR_WINDOW_MIN = 72 * 60;
const MAX_SEQS = 25;

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Diversion cost model (task 07): illustrative estimates, labelled "(estimate)" wherever shown. */
export const DIVERSION_LANDING_HANDLING_EUR = 4500;
export const DIVERSION_FUEL_CREW_EUR = 2500;
export const DIVERSION_ONWARD_EUR_PER_PAX = 30;
export const CARE_SURGE_EUR_PER_PAX = 15;

/** EU261 compensation tier by distance: ≤1500 km €250; intra-EU >1500 km or 1500–3500 km €400; otherwise €600. */
export function eu261TierByDistance(distanceKm: number, intraEu = false): 250 | 400 | 600 {
  if (distanceKm <= 1500) return 250;
  if (intraEu || distanceKm <= 3500) return 400;
  return 600;
}

/** Delay after which care (meals/refreshments) is owed: 2 h (≤1500 km), 3 h (≤3500 km or intra-EU), else 4 h. */
export function careThresholdMin(distanceKm: number | null, intraEu = false): number {
  if (distanceKm === null || distanceKm <= 1500) return 120;
  if (intraEu || distanceKm <= 3500) return 180;
  return 240;
}

function kpi<T>(value: T, formula: string, inputs: Kpi<T>['inputs'], seqs: number[]): Kpi<T> {
  const uniq = [...new Set(seqs)].sort((a, b) => a - b);
  return { value, formula, inputs, contributingSeqs: uniq.slice(-MAX_SEQS) };
}

function values<T>(m: Record<string, T> | undefined): T[] {
  return Object.values(m ?? {});
}

type Mut = RunEvent<'system.mutation'>;

function mutations(events: RunEvent[], system: string, entities: string[]): Mut[] {
  return events.filter(
    (e): e is Mut =>
      e.type === 'system.mutation' && e.payload.system === system && entities.includes(e.payload.entity),
  );
}

function seqsOf(events: RunEvent[]): number[] {
  return events.map((e) => e.seq);
}

export function projectedDelay(f: Flight): number {
  return f.status === 'cancelled' ? 0 : Math.max(f.delayMin, f.reactionaryDelayMin);
}

/** Minute (absolute sim minute) of the first passenger message sent, or null. */
function firstPaxMessageMinute(state: SystemState): number | null {
  const mins: number[] = [];
  for (const m of values(state.pss?.messages)) {
    if (m.status === 'sent' && typeof m.sentAtMinute === 'number') mins.push(m.sentAtMinute);
  }
  for (const c of values(state.pss?.cohorts)) {
    if (typeof c.firstInformedAtMinute === 'number') mins.push(c.firstInformedAtMinute);
  }
  return mins.length ? Math.min(...mins) : null;
}

export function computeKpis(snapshot: WorldSnapshot, params: KpiParams, events: RunEvent[]): KpiSnapshot {
  const { simMinute, triggerMinute, state } = snapshot;
  const dist = (f: string) => snapshot.distanceKm?.(f) ?? null;
  const intra = (f: string) => snapshot.intraEu?.(f) ?? false;
  const incidentClockMin = Math.max(0, simMinute - triggerMinute);
  const since = (min: number) => Math.max(0, min - triggerMinute);

  const flights = values(state.occ?.flights);
  const live = flights.filter((f) => f.status !== 'cancelled');
  const cancelled = flights.filter((f) => f.status === 'cancelled');
  const flightMuts = mutations(events, 'occ', ['flights']);
  const flightSeqs = seqsOf(flightMuts);

  // ------------------------------------------------------------------ delay cost
  const reactionaryOf = (f: Flight) => Math.min(f.reactionaryDelayMin, projectedDelay(f));
  const primaryMin = live.reduce((s, f) => s + projectedDelay(f) - reactionaryOf(f), 0);
  const reactionaryMin = live.reduce((s, f) => s + reactionaryOf(f), 0);
  const delayCost = round2(params.eurPerMinute * (primaryMin + params.reactionaryFactor * reactionaryMin));
  const delayCostEur = kpi(
    delayCost,
    'primary min × €/min + reactionary min × factor × €/min',
    {
      primaryMin,
      reactionaryMin,
      eurPerMinute: params.eurPerMinute,
      reactionaryFactor: params.reactionaryFactor,
    },
    flightSeqs,
  );

  // ------------------------------------------------------------------ EU261 exposure (compensation + care)
  const maxDelay = live.reduce((m, f) => Math.max(m, projectedDelay(f)), 0);
  let compensation = 0;
  let care = 0;
  let paxOver3h = 0;
  let tierUsed: number | null = null;
  for (const f of live) {
    const d = projectedDelay(f);
    const km = dist(f.flight);
    const tier = params.eu261TierEur ?? (km === null ? 250 : eu261TierByDistance(km, intra(f.flight)));
    if (d >= THREE_HOURS_MIN) {
      compensation += f.pax * tier;
      paxOver3h += f.pax;
      tierUsed = tier;
    }
    if (d >= careThresholdMin(km, intra(f.flight))) {
      care += f.pax * params.careEurPerPaxPerHour * Math.floor(d / 60);
    }
  }
  let cancelledPax = 0;
  for (const f of cancelled) {
    const km = dist(f.flight);
    const tier = params.eu261TierEur ?? (km === null ? 250 : eu261TierByDistance(km, intra(f.flight)));
    compensation += f.pax * tier;
    cancelledPax += f.pax;
    tierUsed ??= tier;
  }
  const eu261ExposureEur = kpi(
    round2(compensation + care),
    'Σ pax × tier (flights ≥ 3 h late or cancelled) + Σ pax × €care/pax/h × whole hours late (past care threshold)',
    {
      paxOver3h,
      cancelledPax,
      tierEur: tierUsed,
      compensationEur: round2(compensation),
      careEur: round2(care),
      careEurPerPaxPerHour: params.careEurPerPaxPerHour,
      maxProjectedDelayMin: maxDelay,
    },
    flightSeqs,
  );

  // ------------------------------------------------------------------ cancellation cost
  const cohorts = values(state.pss?.cohorts);
  let accommodationPax = 0;
  for (const f of cancelled) {
    const onFlight = cohorts.filter((c) => c.flight === f.flight);
    accommodationPax += onFlight.length
      ? onFlight.filter((c) => c.status !== 'rebooked').reduce((s, c) => s + c.count, 0)
      : f.pax;
  }
  const cancelCost = round2(
    cancelled.length * params.cancellationFixedEur + accommodationPax * params.accommodationEurPerPax,
  );
  const cancelSeqs = [...flightSeqs, ...seqsOf(mutations(events, 'occ', ['cancellations']))];
  const cancellationCostEur = kpi(
    cancelCost,
    'cancelled flights × fixed € + pax not rebooked × €accommodation/pax',
    {
      cancelledFlights: cancelled.length,
      cancellationFixedEur: params.cancellationFixedEur,
      accommodationPax,
      accommodationEurPerPax: params.accommodationEurPerPax,
    },
    cancelSeqs,
  );

  // ------------------------------------------------------------------ diversion / turnback (task 07, estimate)
  const airborne = values(state.occ?.airborne);
  const diverted = airborne.filter(
    (a) =>
      a.commanderDecision === 'turnback' ||
      a.commanderDecision === 'divert' ||
      a.destination !== a.plannedDestination,
  );
  const divertedPax = diverted.reduce((n, a) => n + a.pax, 0);
  const divCost = round2(
    diverted.length * (DIVERSION_LANDING_HANDLING_EUR + DIVERSION_FUEL_CREW_EUR) +
      divertedPax * (DIVERSION_ONWARD_EUR_PER_PAX + CARE_SURGE_EUR_PER_PAX),
  );
  const diversionCostEur = airborne.length
    ? kpi(
        divCost,
        '(estimate) per diversion or turnback: landing & handling €' +
          DIVERSION_LANDING_HANDLING_EUR +
          ' + fuel & crew €' +
          DIVERSION_FUEL_CREW_EUR +
          '; per passenger: onward transport €' +
          DIVERSION_ONWARD_EUR_PER_PAX +
          ' + care surge €' +
          CARE_SURGE_EUR_PER_PAX,
        {
          diversions: diverted.length,
          passengers: divertedPax,
          careSurgeEur: round2(divertedPax * CARE_SURGE_EUR_PER_PAX),
          estimate: true,
        },
        seqsOf(mutations(events, 'occ', ['airborne', 'commanderLog'])),
      )
    : undefined;

  const totalCostEur = kpi(
    round2(delayCost + eu261ExposureEur.value + cancelCost + divCost),
    diversionCostEur
      ? 'delay cost + EU261 exposure + cancellation cost + diversion (estimate)'
      : 'delay cost + EU261 exposure + cancellation cost',
    {
      delayCostEur: delayCost,
      eu261ExposureEur: eu261ExposureEur.value,
      cancellationCostEur: cancelCost,
      ...(diversionCostEur ? { diversionCostEur: divCost } : {}),
    },
    [...flightSeqs, ...cancelSeqs, ...(diversionCostEur?.contributingSeqs ?? [])],
  );

  // ------------------------------------------------------------------ satisfaction
  const firstMsgAbs = firstPaxMessageMinute(state);
  const informedBy = firstMsgAbs ?? simMinute;
  const uninformedMin = simMinute >= triggerMinute ? Math.max(0, informedBy - triggerMinute) : 0;
  const careActions = values(state.pss?.vouchers).length;
  const cohortMuts = mutations(events, 'pss', ['cohorts']);
  const rebookedAt = new Map<string, number>();
  for (const e of cohortMuts) {
    const after = e.payload.after as { status?: string } | undefined;
    if (after?.status === 'rebooked' && !rebookedAt.has(e.payload.id))
      rebookedAt.set(e.payload.id, e.simMinute);
  }
  let rebookedBefore3h = 0;
  for (const c of cohorts) {
    if (c.status !== 'rebooked') continue;
    const at = rebookedAt.get(c.id) ?? simMinute;
    if (since(at) < THREE_HOURS_MIN) rebookedBefore3h++;
  }
  const rawSat =
    100 -
    0.8 * uninformedMin +
    (firstMsgAbs !== null ? 8 : 0) +
    5 * careActions +
    10 * rebookedBefore3h -
    15 * cancelled.length;
  const satSeqs = [
    ...seqsOf(mutations(events, 'pss', ['messages', 'vouchers', 'cohorts'])),
    ...seqsOf(cancelled.length ? flightMuts : []),
  ];
  const satisfaction = kpi(
    round2(Math.min(100, Math.max(0, rawSat))),
    '100 − 0.8 × min uninformed + 8 (first message) + 5 × care actions + 10 × cohorts rebooked < 3 h − 15 × cancellations; floor 0',
    {
      uninformedMin: round2(uninformedMin),
      firstMessage: firstMsgAbs !== null,
      careActions,
      rebookedBefore3h,
      cancellations: cancelled.length,
    },
    satSeqs,
  );

  // ------------------------------------------------------------------ compliance
  const delayedOrCancelled = maxDelay > 0 || cancelled.length > 0;
  const over3h = maxDelay >= THREE_HOURS_MIN || cancelled.length > 0;
  const rebookProposalAt = events
    .filter((e) => e.type === 'agent.proposal' && e.payload.tool === 'rebook_cohort')
    .map((e) => e.simMinute);
  const reroutingTimes = [...rebookedAt.values(), ...rebookProposalAt];
  const reroutingWithin3h = reroutingTimes.some((m) => since(m) <= THREE_HOURS_MIN);
  const crew = values(state.crew?.crew);
  const fdpBreaches = crew.filter((c) => c.fdpUsedMin > c.maxFdpMin).length;
  const reports = [
    ...values(state.record?.reports).filter((r) => r.kind === 'occurrence'),
    ...values(state.handler?.reports),
  ];
  const morDrafted = reports.some((r) => {
    const at = (r as { createdAtMinute?: number }).createdAtMinute;
    return at === undefined || since(at) <= MOR_WINDOW_MIN;
  });
  const complianceValue: ComplianceValue = {
    art14NoticeIssued: firstMsgAbs !== null,
    reroutingOfferedWithin3h: over3h ? reroutingWithin3h : null,
    fdpRespected: fdpBreaches === 0,
    morDraftedWithin72h: morDrafted,
    threeHourThresholdAvoided: delayedOrCancelled
      ? maxDelay < THREE_HOURS_MIN && cancelled.length === 0
      : null,
  };
  // Task 07: the commander's authority — no attempt to instruct the flight deck or take the commander's decisions.
  const flightDeckAttempts = events.filter(
    (e) =>
      e.type === 'guardrail.blocked' &&
      e.payload.layer === 'tier' &&
      (FLIGHT_DECK_FORBIDDEN_TOOLS as readonly string[]).includes(e.payload.tool ?? '') &&
      e.payload.presenterTriggered !== true,
  ).length;
  if (airborne.length) complianceValue.commanderAuthorityRespected = flightDeckAttempts === 0;
  const compliance = kpi(
    complianceValue,
    airborne.length
      ? 'Art 14 notice sent; rerouting offered ≤ 3 h (if ≥ 3 h or cancelled); no crew over max FDP; occurrence report drafted ≤ 72 h; projected delay < 3 h and no cancellation; commander’s authority respected (no flight-deck instruction or decision attempted by software)'
      : 'Art 14 notice sent; rerouting offered ≤ 3 h (if ≥ 3 h or cancelled); no crew over max FDP; occurrence report drafted ≤ 72 h; projected delay < 3 h and no cancellation',
    {
      ...(airborne.length ? { flightDeckAttempts } : {}),
      firstPaxMessageMin: firstMsgAbs === null ? null : round2(since(firstMsgAbs)),
      maxProjectedDelayMin: maxDelay,
      cancelledFlights: cancelled.length,
      fdpBreaches,
      occurrenceReports: reports.length,
    },
    [
      ...seqsOf(mutations(events, 'pss', ['messages', 'cohorts'])),
      ...seqsOf(mutations(events, 'crew', ['crew'])),
      ...seqsOf(mutations(events, 'record', ['reports'])),
      ...seqsOf(mutations(events, 'handler', ['reports'])),
    ],
  );

  // ------------------------------------------------------------------ safety gates
  const tierBlocks = events.filter((e) => e.type === 'guardrail.blocked' && e.payload.layer === 'tier');
  const proposalsByCall = new Map<string, string>();
  const decided = new Map<string, number>();
  const proposeCalls = new Set<string>();
  for (const e of events) {
    if (e.type === 'agent.tool_call' && e.payload.tier === 'propose') proposeCalls.add(e.payload.toolCallId);
    else if (e.type === 'agent.proposal') proposalsByCall.set(e.payload.toolCallId, e.payload.approvalId);
    else if (e.type === 'approval.decision' && e.payload.decision !== 'reject')
      decided.set(e.payload.approvalId, e.seq);
  }
  let withDecision = 0;
  let withoutDecision = 0;
  const safetySeqs: number[] = seqsOf(tierBlocks);
  for (const e of events) {
    if (e.type !== 'agent.tool_result' || !e.payload.ok || !proposeCalls.has(e.payload.toolCallId)) continue;
    const approvalId = proposalsByCall.get(e.payload.toolCallId);
    const decisionSeq = approvalId ? decided.get(approvalId) : undefined;
    if (decisionSeq !== undefined && decisionSeq < e.seq) withDecision++;
    else withoutDecision++;
    safetySeqs.push(e.seq);
  }
  const safetyValue: SafetyValue = {
    forbiddenAttempts: tierBlocks.length,
    humanDecisionsBeforeDependentActions: withDecision,
    dependentActionsWithoutDecision: withoutDecision,
  };
  // Presenter-triggered attempts ("Demonstrate blocked action") go through the same gate and are counted the same;
  // the inputs say how many of them the presenter pushed, so "why this number" can tell.
  const presenterTriggered = tierBlocks.filter(
    (e) => e.type === 'guardrail.blocked' && e.payload.presenterTriggered === true,
  ).length;
  const safety = kpi(
    safetyValue,
    presenterTriggered
      ? `forbidden tool calls blocked (must be 0 attempts; ${presenterTriggered} presenter-triggered demonstration${presenterTriggered === 1 ? '' : 's'} included); propose-tier actions executed with / without a recorded decision`
      : 'forbidden tool calls blocked (must be 0 attempts); propose-tier actions executed with / without a recorded decision',
    { ...safetyValue, presenterTriggeredAttempts: presenterTriggered },
    safetySeqs,
  );

  // ------------------------------------------------------------------ coordination latency
  const firstMut = (system: string, entities: string[], pred: (after: Record<string, unknown>) => boolean) =>
    mutations(events, system, entities).find((e) => e.payload.after && pred(e.payload.after));
  const engDecision = firstMut('mne', ['decisions'], () => true);
  const swapCancel = firstMut('occ', ['swaps', 'cancellations'], (a) =>
    ['approved', 'requested', 'executed'].includes(String(a.status)),
  );
  const swapApproval = events.find(
    (e) =>
      e.type === 'approval.decision' &&
      e.payload.decision !== 'reject' &&
      events.some(
        (p) =>
          p.type === 'agent.proposal' &&
          p.payload.approvalId === e.payload.approvalId &&
          (p.payload.tool === 'propose_swap' || p.payload.tool === 'propose_cancel'),
      ),
  );
  const swapCandidates = [swapCancel, swapApproval].filter((e): e is RunEvent => !!e);
  const swapFirst = swapCandidates.sort((a, b) => a.seq - b.seq)[0];
  const latencyValue: LatencyValue = {
    firstEngineeringDecisionMin: engDecision ? round2(since(engDecision.simMinute)) : null,
    firstPaxMessageMin: firstMsgAbs === null ? null : round2(since(firstMsgAbs)),
    swapOrCancelDecisionMin: swapFirst ? round2(since(swapFirst.simMinute)) : null,
  };
  const latency = kpi(
    latencyValue,
    'sim minutes from the trigger to the first engineering decision, passenger message and swap/cancel decision',
    { ...latencyValue, triggerMinute },
    [engDecision?.seq, swapFirst?.seq].filter((s): s is number => typeof s === 'number'),
  );

  return {
    simMinute: round2(simMinute),
    incidentClockMin: round2(incidentClockMin),
    minutesTo3h: round2(THREE_HOURS_MIN - maxDelay),
    delayCostEur,
    eu261ExposureEur,
    cancellationCostEur,
    totalCostEur,
    satisfaction,
    compliance,
    safety,
    latency,
    ...(diversionCostEur ? { diversionCostEur } : {}),
  };
}

/** Compare the values (not formulas/seqs) of two snapshots: true when a KPI value changed. */
export function kpiValuesChanged(a: KpiSnapshot | null, b: KpiSnapshot): boolean {
  if (!a) return true;
  const keys = [
    'delayCostEur',
    'eu261ExposureEur',
    'cancellationCostEur',
    'totalCostEur',
    'satisfaction',
    'compliance',
    'safety',
    'latency',
  ] as const;
  return (
    keys.some((k) => JSON.stringify(a[k].value) !== JSON.stringify(b[k].value)) ||
    a.minutesTo3h !== b.minutesTo3h
  );
}
