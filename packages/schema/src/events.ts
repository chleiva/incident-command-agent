/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Run events (spec §5, §6): a discriminated union keyed by `type`. Every agent step, tool call, world tick, KPI
 * update, mutation and approval is one event row `RUN#{runId}` / `EVT#{seq:08d}`.
 *
 * Rules:
 * - `seq` is 1-based and gap-free per run; only the Store assigns it (`Store.append`).
 * - Payloads may gain optional fields (additive only). Unknown payload fields are allowed by the validators.
 * - Untrusted text inside payloads (thoughts, tool results, twist text) is data; the UI renders it as text only.
 */
import { Type, type Static, type TObject } from '@sinclair/typebox';
import {
  AgentReportEventSchema,
  ApprovalScopeSchema,
  AssumptionSchema,
  CitationSchema,
  DecisionOptionSchema,
  ProviderModelSchema,
  RunLimitsSchema,
  RunTotalsSchema,
  UsageSchema,
} from './common';
import {
  ActorSchema,
  AgentRoleSchema,
  RunModeSchema,
  StateSystemNameSchema,
  TierSchema,
  ToolSystemSchema,
  literalUnion,
} from './ids';
import { KpiSnapshotSchema } from './kpi';
import { TwistEffectSchema } from './scenario';

const Str = Type.String();
const Opt = Type.Optional;
const Json = Type.Record(Type.String(), Type.Unknown());

export const MUTATION_OPS = ['create', 'update', 'delete'] as const;
export const MutationOpSchema = literalUnion(MUTATION_OPS);
export type MutationOp = Static<typeof MutationOpSchema>;

export const AGENT_ABORT_REASONS = [
  'iterations',
  'tool_calls',
  'tokens',
  'wall_clock',
  'budget',
  'error',
  'stopped',
] as const;
export const GUARDRAIL_LAYERS = [
  'tier',
  'input_screen',
  'output_screen',
  'arg_validation',
  'ref_validation',
] as const;
/** `demo_forbidden` (addition, task 06): presenter control that pushes a forbidden call through the tier gate. */
export const CONTROL_ACTIONS = ['pause', 'resume', 'stop', 'set_speed', 'demo_forbidden'] as const;
/** Tools the presenter may demonstrate with `demo_forbidden` (default `defer_defect`). */
export const DEMO_FORBIDDEN_TOOLS = ['defer_defect', 'release_aircraft', 'extend_crew_fdp'] as const;
export const DemoForbiddenToolSchema = literalUnion(DEMO_FORBIDDEN_TOOLS);
export type DemoForbiddenTool = Static<typeof DemoForbiddenToolSchema>;
export const APPROVAL_DECISIONS = ['approve', 'edit', 'reject'] as const;
export const ApprovalDecisionKindSchema = literalUnion(APPROVAL_DECISIONS);
export type ApprovalDecisionKind = Static<typeof ApprovalDecisionKindSchema>;

const SpeedSchema = Type.Number({ minimum: 0, maximum: 60, description: 'Sim-time multiplier (default 6)' });

/** Payload schema per event type. Keys are the event `type` strings. */
/** Addition (async authoring): `scenario.authoring.status`. */
export const SCENARIO_AUTHORING_STATUSES = ['started', 'patched', 'fallback'] as const;
export type ScenarioAuthoringStatus = (typeof SCENARIO_AUTHORING_STATUSES)[number];

export const EventPayloadSchemas = {
  'run.created': Type.Object({
    scenarioId: Str,
    mode: RunModeSchema,
    pairedRunId: Opt(Str),
    speed: SpeedSchema,
    config: Type.Object({
      provider: Str,
      model: Str,
      limits: RunLimitsSchema,
      /** Addition: optional fallback provider/model. */
      fallback: Opt(ProviderModelSchema),
    }),
  }),
  'run.started': Type.Object({ speed: SpeedSchema }),
  'run.paused': Type.Object({ speed: SpeedSchema }),
  'run.resumed': Type.Object({ speed: SpeedSchema }),
  /** Addition: emitted by the runtime after it applies `control.requested{set_speed}`. */
  'run.speed_changed': Type.Object({ speed: SpeedSchema }),
  'run.completed': Type.Object({
    reason: literalUnion(['report', 'horizon', 'stopped'] as const),
    totals: RunTotalsSchema,
    finalKpis: KpiSnapshotSchema,
  }),
  'run.failed': Type.Object({ error: Str, where: Str }),
  /** Emitted once per sim minute (not every 10-second tick). */
  'world.tick': Type.Object({ simMinute: Type.Number() }),
  'world.twist': Type.Object({
    twistId: Opt(Str),
    title: Str,
    /** Untrusted text. */
    description: Str,
    source: literalUnion(['scheduled', 'manual', 'free_text'] as const),
    effects: Type.Array(TwistEffectSchema),
  }),
  /** A modelled process moved (engineer arrived, stand confirmed…). The mutations follow as system.mutation. */
  'world.process': Type.Object({
    system: StateSystemNameSchema,
    entity: Str,
    id: Str,
    /** Short human-readable description, e.g. "engineer on site". */
    change: Str,
  }),
  'kpi.update': KpiSnapshotSchema,
  /**
   * One per persisted mock-state change. `after` is the FULL entity after the change (not a patch);
   * omitted for `delete`. The reducer rebuilds `SystemState` from these events alone.
   */
  'system.mutation': Type.Object({
    system: StateSystemNameSchema,
    entity: Str,
    id: Str,
    op: MutationOpSchema,
    before: Opt(Json),
    after: Opt(Json),
    causedBySeq: Opt(Type.Integer({ minimum: 1 })),
  }),
  'agent.started': Type.Object({
    role: AgentRoleSchema,
    brief: Str,
    parentAgentRunId: Opt(Str),
  }),
  'agent.thought': Type.Object({
    text: Str,
    /** ≤ 120 chars, for the collapsed card (first sentence, trimmed; no extra LLM call). */
    summary: Type.String({ maxLength: 120 }),
  }),
  'agent.tool_call': Type.Object({
    toolCallId: Str,
    tool: Str,
    system: ToolSystemSchema,
    tier: TierSchema,
    args: Json,
    /** Addition (task 06): a synthetic call pushed by the presenter's "Demonstrate blocked action" control. */
    presenterTriggered: Opt(Type.Boolean()),
    /**
     * Addition (live-run fix): the model called a tool named after a role (e.g. `ground{brief}`); the runtime
     * normalised it to `delegate{role, brief}` under the same toolCallId. Holds the original tool name.
     */
    normalisedFrom: Opt(Str),
    /**
     * Addition (live-run fix): argument keys the runtime recovered from a string value where the model leaked
     * tool-call markup (`</parameter><parameter name="k">…`).
     */
    argsRepaired: Opt(Type.Array(Str)),
  }),
  'agent.tool_result': Type.Object({
    toolCallId: Str,
    tool: Str,
    ok: Type.Boolean(),
    /** ≤ 500 chars. */
    resultPreview: Type.String({ maxLength: 500 }),
    result: Opt(Type.Unknown()),
    citations: Opt(Type.Array(CitationSchema)),
    /** Addition (task 06): a retry with an already-used `requestId`: the original call's id (no new mutation). */
    deduplicatedFrom: Opt(Str),
  }),
  'agent.proposal': Type.Object({
    approvalId: Str,
    toolCallId: Str,
    tool: Str,
    args: Json,
    summary: Str,
    reasoning: Str,
    options: Opt(Type.Array(DecisionOptionSchema)),
    expiresAtMinute: Opt(Type.Number()),
    /** Addition: tier of the proposed tool (always 'propose' today) for the UI badge. */
    tier: Opt(TierSchema),
    /** Additions (task 06): provenance and scope shown on the decision card. */
    unresolvedChecks: Opt(Type.Array(Str)),
    approvalScope: Opt(ApprovalScopeSchema),
    citations: Opt(Type.Array(CitationSchema)),
    /** Sim minute of the newest data the proposal is based on (filled by the runtime). */
    dataAsOfMinute: Opt(Type.Number()),
    /** Facts the proposal depends on; a change after approval emits `approval.invalidated`. */
    assumptions: Opt(Type.Array(AssumptionSchema)),
    /** A revised proposal issued after `approval.invalidated`: the invalidated approval it replaces. */
    supersedesApprovalId: Opt(Str),
  }),
  'approval.decision': Type.Object({
    approvalId: Str,
    decision: ApprovalDecisionKindSchema,
    editedArgs: Opt(Json),
    selectedOptionId: Opt(Str),
    reason: Opt(Str),
    decidedBy: ActorSchema,
  }),
  /**
   * Addition (task 06): an assumption of an already approved decision changed (twist or any mutation). The owning
   * agent re-gathers evidence and issues a revised proposal with `supersedesApprovalId`.
   */
  'approval.invalidated': Type.Object({
    approvalId: Str,
    affectedAssumptions: Type.Array(
      Type.Object({ key: Str, was: Type.Unknown(), now: Type.Unknown(), source: Opt(Str) }),
    ),
    /** Seq of the event whose mutation changed the assumption (a twist or a process). */
    causedBySeq: Opt(Type.Integer({ minimum: 1 })),
    /** Role that will re-gather the evidence. */
    role: Opt(AgentRoleSchema),
  }),
  'agent.report': Type.Object({ role: AgentRoleSchema, report: AgentReportEventSchema }),
  'agent.aborted': Type.Object({
    role: AgentRoleSchema,
    reason: literalUnion(AGENT_ABORT_REASONS),
    detail: Str,
  }),
  'guardrail.blocked': Type.Object({
    layer: literalUnion(GUARDRAIL_LAYERS),
    tool: Opt(Str),
    reason: Str,
    excerpt: Opt(Str),
    /** Addition: the blocked tool call, when there is one. */
    toolCallId: Opt(Str),
    /** Additions (task 06), tier blocks: the rule and who holds the authority (e.g. "Certifying staff"). */
    rule: Opt(Str),
    authority: Opt(Str),
    /** The attempt was pushed by the presenter's "Demonstrate blocked action" control (counted the same). */
    presenterTriggered: Opt(Type.Boolean()),
  }),
  /** Written by the API; drained by the Run Lambda on its next iteration. */
  'twist.requested': Type.Object({ twistId: Opt(Str), text: Opt(Str) }),
  /** Written by the API (kill-switch = stop, Space = pause/resume). */
  'control.requested': Type.Object({
    action: literalUnion(CONTROL_ACTIONS),
    speed: Opt(SpeedSchema),
    /** Addition (task 06): for `demo_forbidden` (default `defer_defect`). */
    tool: Opt(DemoForbiddenToolSchema),
  }),
  'baseline.action': Type.Object({ actor: Str, tool: Str, args: Json, note: Str }),
  'llm.fallback': Type.Object({ from: ProviderModelSchema, to: ProviderModelSchema, reason: Str }),
  /**
   * Addition (async authoring): preparing a flight-context scenario from the duty manager's free text before the
   * world starts. `started` (written by the API with `run.created`), then `patched` (the Author's patch was merged and
   * validated) or `fallback` (the template scenario is used unchanged). Actor `world`; `detail` is UI copy.
   */
  'scenario.authoring': Type.Object({
    status: literalUnion(SCENARIO_AUTHORING_STATUSES),
    detail: Str,
    /** Why the patch was not used (validation/reference errors, timeout, provider error), for the log. */
    errors: Opt(Type.Array(Str)),
    /** The Author's LLM spend (not included in the run's totals). */
    costUsd: Opt(Type.Number({ minimum: 0 })),
  }),
} satisfies Record<string, TObject>;

export type EventType = keyof typeof EventPayloadSchemas;
export const EVENT_TYPES = Object.keys(EventPayloadSchemas) as EventType[];

export type EventPayloadMap = { [K in EventType]: Static<(typeof EventPayloadSchemas)[K]> };

/** The envelope shared by every event (payload validated separately per type). */
export const EventEnvelopeSchema = Type.Object({
  runId: Type.String({ minLength: 1 }),
  seq: Type.Integer({ minimum: 1 }),
  type: Type.String(),
  actor: ActorSchema,
  /** Unique per runAgent invocation. Baseline runs use 'baseline'. */
  agentRunId: Opt(Str),
  parentAgentRunId: Opt(Str),
  iteration: Opt(Type.Integer({ minimum: 0 })),
  /** Minutes since scenario start (float). */
  simMinute: Type.Number({ minimum: 0 }),
  simTime: Type.String({ format: 'date-time' }),
  wallTime: Type.String({ format: 'date-time' }),
  usage: Opt(UsageSchema),
  latencyMs: Opt(Type.Number({ minimum: 0 })),
  /** S3 key traces/{runId}/{seq}.json of the full LLM request/response. */
  traceKey: Opt(Str),
  payload: Type.Record(Type.String(), Type.Unknown()),
});

export interface RunEventBase {
  runId: string;
  seq: number;
  actor: Static<typeof ActorSchema>;
  agentRunId?: string;
  parentAgentRunId?: string;
  iteration?: number;
  simMinute: number;
  simTime: string;
  wallTime: string;
  usage?: Static<typeof UsageSchema>;
  latencyMs?: number;
  traceKey?: string;
}

/**
 * `RunEvent` = union of every event type; `RunEvent<'agent.proposal'>` = that one type.
 * Narrow with `e.type === '...'` or the `isEvent(e, type)` guard.
 */
export type RunEvent<T extends EventType = EventType> = T extends EventType
  ? RunEventBase & { type: T; payload: EventPayloadMap[T] }
  : never;

/**
 * What callers pass to `Store.append`: an event without `runId`/`seq` (assigned by the store).
 * `wallTime` defaults to now if omitted.
 */
export type EventDraft<T extends EventType = EventType> = T extends EventType
  ? Omit<RunEventBase, 'runId' | 'seq' | 'wallTime'> & {
      wallTime?: string;
      type: T;
      payload: EventPayloadMap[T];
    }
  : never;

export function isEvent<T extends EventType>(e: RunEvent, type: T): e is RunEvent<T> {
  return e.type === type;
}

/** Type-safe draft constructor. */
export function draft<T extends EventType>(
  type: T,
  payload: EventPayloadMap[T],
  envelope: Omit<RunEventBase, 'runId' | 'seq' | 'wallTime'> & { wallTime?: string },
): EventDraft<T> {
  return { ...envelope, type, payload } as EventDraft<T>;
}

/** `EVT#00000042` sort key for a seq. */
export function eventSortKey(seq: number): string {
  return `EVT#${String(seq).padStart(8, '0')}`;
}

// ------------------------------------------------------------------------------------------------ approvals
export const APPROVAL_STATUSES = ['pending', 'approved', 'edited', 'rejected', 'expired'] as const;
export const ApprovalStatusSchema = literalUnion(APPROVAL_STATUSES);
export type ApprovalStatus = Static<typeof ApprovalStatusSchema>;

/** `APR#{approvalId}` row. Created by the runtime with the `agent.proposal`; decided by the API or a policy. */
export const ApprovalRecordSchema = Type.Object({
  runId: Str,
  approvalId: Str,
  status: ApprovalStatusSchema,
  agentRunId: Str,
  role: AgentRoleSchema,
  toolCallId: Str,
  tool: Str,
  args: Json,
  summary: Str,
  reasoning: Opt(Str),
  options: Opt(Type.Array(DecisionOptionSchema)),
  /** Seq of the `agent.proposal` event. */
  proposalSeq: Type.Integer({ minimum: 1 }),
  createdAtMinute: Type.Number(),
  expiresAtMinute: Opt(Type.Number()),
  decision: Opt(
    Type.Object({
      decision: ApprovalDecisionKindSchema,
      editedArgs: Opt(Json),
      selectedOptionId: Opt(Str),
      reason: Opt(Str),
      decidedBy: ActorSchema,
      /** Seq of the `approval.decision` event. */
      seq: Type.Integer({ minimum: 1 }),
      decidedAt: Type.String({ format: 'date-time' }),
    }),
  ),
});
export type ApprovalRecord = Static<typeof ApprovalRecordSchema>;

/** Map a decision kind to the resulting approval status. */
export function approvalStatusFor(decision: ApprovalDecisionKind): ApprovalStatus {
  return decision === 'approve' ? 'approved' : decision === 'edit' ? 'edited' : 'rejected';
}
