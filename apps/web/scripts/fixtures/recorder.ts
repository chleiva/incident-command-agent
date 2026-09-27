/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * A tiny deterministic event recorder used to author the mock-mode fixtures (fictional data only).
 * It is fixture tooling, not a runtime: it only emits contract-shaped `RunEvent`s that the shared reducer folds.
 */
import type {
  Actor,
  ApprovalScope,
  AgentRole,
  EventPayloadMap,
  EventType,
  KpiSnapshot,
  RunEvent,
  Scenario,
  StateSystemName,
  Usage,
} from '@ica/schema';

export const WORLD: Actor = { kind: 'world' };

/** Notification and work-order tools take a client-generated `requestId` (task 06 §1.9). */
export const IDEMPOTENT_TOOLS = new Set([
  'create_work_order',
  'page_engineer',
  'notify_handler',
  'send_passenger_message',
  'request_bus',
  'request_tow',
  'request_stand',
  'assign_standby_crew',
]);

/** A deterministic UUID-shaped request id for a fixture tool call. */
export function fixtureRequestId(runId: string, toolCallId: string): string {
  const h = [...`${runId}:${toolCallId}`].reduce((a, c) => (Math.imul(a, 31) + c.charCodeAt(0)) >>> 0, 7);
  const n = toolCallId.replace(/\D/g, '').padStart(12, '0').slice(-12);
  return `${h.toString(16).padStart(8, '0').slice(0, 8)}-0000-4000-8000-${n}`;
}

/** Approval scopes as the runtime fills them from the tool definitions (services/run/tools). */
export const SCOPE: Record<
  | 'send_passenger_message'
  | 'request_decision'
  | 'propose_swap'
  | 'issue_care_vouchers'
  | 'record_engineering_decision'
  | 'recommendation',
  ApprovalScope
> = {
  send_passenger_message: {
    authorises: 'Sending this exact message, once, to the listed cohorts on the channel shown.',
    doesNotAuthorise: [
      'Any other message or a later update (each needs its own approval)',
      'Rebooking, care vouchers or compensation decisions',
    ],
  },
  request_decision: {
    authorises:
      'Choosing the selected option as the plan. Each action it leads to is still proposed and approved on its own.',
    doesNotAuthorise: [
      'Executing any action (swap, cancellation, messages, crew changes)',
      'Any human-only decision (deferral, release, FDP extension, departure)',
    ],
  },
  propose_swap: {
    authorises: 'Sending this swap request to Operations Control (OCC). OCC confirms and executes the swap.',
    doesNotAuthorise: [
      'Executing the swap: OCC confirms and executes it',
      'Crew changes, passenger messages or rebooking',
      'Any release of either aircraft (certifying staff)',
    ],
  },
  issue_care_vouchers: {
    authorises: 'Issuing the listed care vouchers to the cohorts shown.',
    doesNotAuthorise: [
      'Compensation decisions (passengers keep their rights)',
      'Hotel or rebooking beyond the vouchers listed',
    ],
  },
  record_engineering_decision: {
    authorises: 'Recording this engineering decision in the tech log as taken by you, the approver.',
    doesNotAuthorise: [
      'Anything a certifying engineer has not decided: deferral and release take effect only if you are certifying staff',
      'Departure (the commander decides)',
    ],
  },
  recommendation: {
    authorises:
      'Nothing by itself: a recommendation for the duty manager. Any action it leads to is proposed and approved separately.',
    doesNotAuthorise: [
      'Any change to airline systems',
      'Any human-only decision (deferral, release, FDP extension, departure)',
    ],
  },
};

/** Rule and authority on a tier block (mirrors the runtime's FORBIDDEN_RULES). */
export const FORBIDDEN = {
  defer_defect: {
    rule: 'Deferral under the MEL is a certifying-staff decision (Part-145 / ORO.MLR.105)',
    authority: 'Certifying staff',
  },
  extend_crew_fdp: {
    rule: "Extending a flight duty period is the commander's discretion (ORO.FTL.205(f))",
    authority: 'Aircraft commander',
  },
} as const;
export const agent = (role: AgentRole): Actor => ({ kind: 'agent', role });
export const human = (name: string, roleTitle: string): Actor => ({ kind: 'human', name, roleTitle });

type Loose = Record<string, Record<string, Record<string, Record<string, unknown>>>>;

export interface Extra {
  agentRunId?: string;
  parentAgentRunId?: string;
  iteration?: number;
  usage?: Usage;
  latencyMs?: number;
}

/** Thought summaries are ≤ 120 chars (contract): cut at a word boundary. */
export function clip(text: string, max = 120): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  return `${cut.slice(0, cut.lastIndexOf(' '))}…`;
}

/** Sonnet-class list prices per MTok, for plausible fixture usage figures only. */
export function usage(inputTokens: number, outputTokens: number, cacheReadTokens = 0): Usage {
  const costUsd = +((inputTokens * 3 + outputTokens * 15 + cacheReadTokens * 0.3) / 1e6).toFixed(6);
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens: 0,
    costUsd,
    model: 'claude-sonnet-5',
    provider: 'anthropic',
  };
}

export interface KpiState {
  /** Projected primary delay of the incident flight (min). */
  primaryDelay: number;
  /** Sum of projected knock-on delay on later sectors (min). */
  reactionary: number;
  pax: number;
  eurPerMinute: number;
  reactionaryFactor: number;
  eu261TierEur: number;
  careEurPerPaxPerHour: number;
  triggerMinute: number;
  firstMsgMin: number | null;
  careActions: number;
  carePax: number;
  careFromMin: number | null;
  rebooked: boolean;
  forbidden: number;
  humanDecisions: number;
  dependentWithoutDecision: number;
  engDecisionMin: number | null;
  swapDecisionMin: number | null;
  morDrafted: boolean;
  resolved: boolean;
  /** Seqs that moved each family of KPIs. */
  seqs: { cost: number[]; sat: number[]; compliance: number[]; safety: number[]; latency: number[] };
}

export class Recorder {
  readonly events: RunEvent[] = [];
  readonly state: Loose = {};
  private tick = 0;
  private readonly start: number;
  /** Emit a KPI snapshot every N whole minutes. */
  kpiEvery = 2;

  constructor(
    readonly runId: string,
    readonly scenario: Scenario,
    readonly wallStart: number,
    readonly kpi: KpiState,
  ) {
    this.start = Date.parse(scenario.startSimTime);
  }

  get lastSeq(): number {
    return this.events.length;
  }

  push<T extends EventType>(
    type: T,
    simMinute: number,
    actor: Actor,
    payload: EventPayloadMap[T],
    extra: Extra = {},
  ): RunEvent<T> {
    // Keep the log chronological: whole-minute world ticks are emitted before any later event.
    if (type !== 'world.tick') this.advanceTo(Math.floor(simMinute));
    const seq = this.events.length + 1;
    const prev = this.events[this.events.length - 1];
    if (prev && simMinute < prev.simMinute) throw new Error(`time went backwards at seq ${seq} (${type})`);
    const e = {
      runId: this.runId,
      seq,
      type,
      actor,
      ...extra,
      simMinute: +simMinute.toFixed(2),
      simTime: new Date(this.start + simMinute * 60_000).toISOString(),
      // 6× speed: one sim minute = 10 s of wall time, plus a small per-event spacing.
      wallTime: new Date(this.wallStart + simMinute * 10_000 + (seq % 7) * 90).toISOString(),
      ...(extra.usage ? { traceKey: `traces/${this.runId}/${seq}.json` } : {}),
      payload,
    } as unknown as RunEvent<T>;
    this.events.push(e);
    return e;
  }

  get<T = Record<string, unknown>>(system: StateSystemName, entity: string, id: string): T | undefined {
    return this.state[system]?.[entity]?.[id] as T | undefined;
  }

  /** Create or replace an entity (full `after`), emitting `system.mutation`. */
  put(
    minute: number,
    actor: Actor,
    system: StateSystemName,
    entity: string,
    id: string,
    after: Record<string, unknown>,
    opts: Extra & { causedBySeq?: number } = {},
  ): RunEvent<'system.mutation'> {
    const before = this.get(system, entity, id);
    this.state[system] ??= {};
    this.state[system][entity] ??= {};
    this.state[system][entity][id] = after;
    const { causedBySeq, ...extra } = opts;
    return this.push(
      'system.mutation',
      minute,
      actor,
      {
        system,
        entity,
        id,
        op: before ? 'update' : 'create',
        ...(before ? { before } : {}),
        after,
        ...(causedBySeq ? { causedBySeq } : {}),
      },
      extra,
    );
  }

  /** Patch an existing entity (emits the FULL entity as `after`). */
  patch(
    minute: number,
    actor: Actor,
    system: StateSystemName,
    entity: string,
    id: string,
    patch: Record<string, unknown>,
    opts: Extra & { causedBySeq?: number } = {},
  ): RunEvent<'system.mutation'> {
    const before = this.get(system, entity, id);
    if (!before) throw new Error(`patch of unknown ${system}/${entity}/${id}`);
    return this.put(minute, actor, system, entity, id, { ...before, ...patch }, opts);
  }

  /** Emit `world.tick` (and a KPI snapshot every `kpiEvery` minutes) for each whole minute up to `minute`. */
  advanceTo(minute: number): void {
    while (this.tick + 1 <= minute) {
      this.tick += 1;
      this.push('world.tick', this.tick, WORLD, { simMinute: this.tick });
      if (this.tick % this.kpiEvery === 0) this.kpiUpdate(this.tick);
    }
  }

  kpiUpdate(minute: number): RunEvent<'kpi.update'> {
    return this.push('kpi.update', minute, WORLD, computeKpis(minute, this.kpi));
  }
}

const uniq = (xs: number[]) => [...new Set(xs)].sort((a, b) => a - b).slice(-12);

/** Fixture KPI model, shaped like spec §8 (task 02 owns the real formulas). */
export function computeKpis(minute: number, k: KpiState): KpiSnapshot {
  const incidentClockMin = Math.max(0, +(minute - k.triggerMinute).toFixed(1));
  const primary = k.primaryDelay;
  const delayCost = Math.round(
    primary * k.eurPerMinute + k.reactionary * k.reactionaryFactor * k.eurPerMinute,
  );
  const over3h = primary >= 180;
  const careHours = k.careFromMin === null ? 0 : Math.max(0, (minute - k.careFromMin) / 60);
  const careCost = Math.round(
    k.carePax * k.careEurPerPaxPerHour * Math.max(1, careHours) * (k.careActions ? 1 : 0),
  );
  const eu261 = (over3h ? k.pax * k.eu261TierEur : 0) + careCost;
  const uninformed = Math.max(0, (k.firstMsgMin ?? minute) - k.triggerMinute);
  const satisfaction = Math.max(
    0,
    Math.min(
      100,
      Math.round(
        100 -
          0.8 * uninformed -
          0.15 * Math.max(0, primary - 30) +
          (k.firstMsgMin !== null ? 8 : 0) +
          5 * k.careActions +
          (k.rebooked ? 10 : 0),
      ),
    ),
  );
  const total = delayCost + eu261;
  return {
    simMinute: minute,
    incidentClockMin,
    minutesTo3h: Math.round(180 - primary),
    delayCostEur: {
      value: delayCost,
      formula: 'primary min × €/min + reactionary min × factor × €/min',
      inputs: {
        primaryMin: primary,
        reactionaryMin: k.reactionary,
        eurPerMinute: k.eurPerMinute,
        reactionaryFactor: k.reactionaryFactor,
      },
      contributingSeqs: uniq(k.seqs.cost),
    },
    eu261ExposureEur: {
      value: eu261,
      formula: 'pax × tier when projected delay ≥ 3 h, plus care cost by elapsed hours',
      inputs: {
        pax: k.pax,
        tierEur: k.eu261TierEur,
        projectedDelayMin: primary,
        carePax: k.carePax,
        careEurPerPaxPerHour: k.careEurPerPaxPerHour,
      },
      contributingSeqs: uniq(k.seqs.cost),
    },
    cancellationCostEur: {
      value: 0,
      formula: 'fixed per-scenario value + rebooking + accommodation (only if cancelled)',
      inputs: { cancelled: false, cancellationFixedEur: 18600 },
      contributingSeqs: [],
    },
    totalCostEur: {
      value: total,
      formula: 'delay cost + EU261 exposure + cancellation cost',
      inputs: { delayCostEur: delayCost, eu261ExposureEur: eu261, cancellationCostEur: 0 },
      contributingSeqs: uniq(k.seqs.cost),
    },
    satisfaction: {
      value: satisfaction,
      formula:
        '100 − 0.8/min uninformed − 0.15/min delay beyond 30 + 8 first message + 5/care action + 10 rebooked < 3 h',
      inputs: {
        uninformedMin: uninformed,
        projectedDelayMin: primary,
        firstMessageMin: k.firstMsgMin,
        careActions: k.careActions,
        rebookedBefore3h: k.rebooked,
      },
      contributingSeqs: uniq(k.seqs.sat),
    },
    compliance: {
      value: {
        art14NoticeIssued: k.firstMsgMin !== null,
        reroutingOfferedWithin3h: over3h ? k.rebooked : null,
        fdpRespected: true,
        morDraftedWithin72h: k.morDrafted,
        threeHourThresholdAvoided: k.resolved ? !over3h : null,
      },
      formula:
        'EU261 Art 14 notice · rerouting ≤ 3 h · FTL FDP respected · MOR drafted ≤ 72 h · 3-h threshold',
      inputs: {
        firstPaxMessageMin: k.firstMsgMin,
        projectedDelayMin: primary,
        morDrafted: k.morDrafted,
      },
      contributingSeqs: uniq(k.seqs.compliance),
    },
    safety: {
      value: {
        forbiddenAttempts: k.forbidden,
        humanDecisionsBeforeDependentActions: k.humanDecisions,
        dependentActionsWithoutDecision: k.dependentWithoutDecision,
      },
      formula:
        'forbidden tool attempts (must be 0 executed) · human decisions recorded before dependent actions',
      inputs: {
        forbiddenAttemptsBlocked: k.forbidden,
        humanDecisions: k.humanDecisions,
        presenterTriggeredAttempts: 0,
      },
      contributingSeqs: uniq(k.seqs.safety),
    },
    latency: {
      value: {
        firstEngineeringDecisionMin: k.engDecisionMin,
        firstPaxMessageMin: k.firstMsgMin,
        swapOrCancelDecisionMin: k.swapDecisionMin,
      },
      formula: 'sim minutes from the trigger to the first decision / message',
      inputs: { triggerMinute: k.triggerMinute },
      contributingSeqs: uniq(k.seqs.latency),
    },
  };
}

export function kpiState(scenario: Scenario, pax: number, eu261TierEur: number): KpiState {
  return {
    primaryDelay: 0,
    reactionary: 0,
    pax,
    eurPerMinute: scenario.kpiParams.eurPerMinute,
    reactionaryFactor: scenario.kpiParams.reactionaryFactor,
    eu261TierEur,
    careEurPerPaxPerHour: scenario.kpiParams.careEurPerPaxPerHour,
    triggerMinute: scenario.trigger.atMinute,
    firstMsgMin: null,
    careActions: 0,
    carePax: 0,
    careFromMin: null,
    rebooked: false,
    forbidden: 0,
    humanDecisions: 0,
    dependentWithoutDecision: 0,
    engDecisionMin: null,
    swapDecisionMin: null,
    morDrafted: false,
    resolved: false,
    seqs: { cost: [], sat: [], compliance: [], safety: [], latency: [] },
  };
}

/** Seed the world from the scenario as `system.mutation` events (actor world), like the runtime does. */
export function seedWorld(r: Recorder): void {
  const s = r.scenario;
  const W = WORLD;
  r.put(0, W, 'mne', 'aircraft', s.aircraft.tail, {
    tail: s.aircraft.tail,
    type: s.aircraft.type,
    station: s.aircraft.station,
    status: 'serviceable',
    ...(s.aircraft.stand ? { stand: s.aircraft.stand } : {}),
    // Only the record fields the scenario states; the UI shows the rest as "Unknown".
    ...(s.aircraft.maintenance ? { maintenance: { ...s.aircraft.maintenance } } : {}),
  });
  for (const leg of s.world.rotation) {
    r.put(0, W, 'occ', 'flights', leg.flight, {
      flight: leg.flight,
      tail: leg.tail,
      from: leg.from,
      to: leg.to,
      std: leg.std,
      sta: leg.sta,
      status: 'scheduled',
      delayMin: 0,
      reactionaryDelayMin: 0,
      pax: leg.pax,
    });
  }
  for (const sp of s.world.spares) {
    r.put(0, W, 'occ', 'spares', sp.tail, {
      tail: sp.tail,
      type: sp.type,
      station: sp.station,
      availableFromMinute: sp.availableFromMinute,
    });
  }
  for (const c of s.world.curfews) r.put(0, W, 'occ', 'curfews', c.station, { ...c });
  for (const c of s.world.crew) {
    const report = Date.parse(c.reportTime);
    const used = Math.max(0, Math.round((Date.parse(s.startSimTime) - report) / 60_000));
    r.put(0, W, 'crew', 'crew', c.id, {
      id: c.id,
      name: c.name,
      rank: c.rank,
      status: c.status,
      station: c.station,
      reportTime: c.reportTime,
      sectorsPlanned: c.sectorsPlanned,
      maxFdpMin: c.maxFdpMin,
      fdpUsedMin: used,
      fdpRemainingMin: c.maxFdpMin - used,
      ...(c.status === 'operating' ? { assignedFlight: s.aircraft.nextSectors[0]?.flight } : {}),
    });
  }
  for (const c of s.world.cohorts) {
    r.put(0, W, 'pss', 'cohorts', c.id, {
      id: c.id,
      kind: c.kind,
      count: c.count,
      flight: c.flight,
      status: 'uninformed',
      careIssued: 0,
      ...(c.onwardDeadline ? { onwardDeadline: c.onwardDeadline } : {}),
      ...(c.notes ? { notes: c.notes } : {}),
    });
  }
  for (const st of s.world.stands) r.put(0, W, 'airport', 'stands', st.id, { ...st });
  r.put(0, W, 'airport', 'weather', s.world.weather.station, { ...s.world.weather });
  for (const eq of s.world.handler.equipment) {
    const id = `${s.world.handler.station}:${eq.kind}`;
    r.put(0, W, 'handler', 'equipment', id, {
      id,
      station: s.world.handler.station,
      kind: eq.kind,
      available: eq.count,
      total: eq.count,
    });
  }
  for (const e of s.world.engineers) {
    r.put(0, W, 'engineers', 'engineers', e.id, {
      id: e.id,
      name: e.name,
      station: e.station,
      licence: e.licence,
      skills: e.skills,
      status: e.availableFromMinute > 0 ? 'busy' : 'available',
      location: e.station,
    });
  }
}
