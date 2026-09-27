/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * The shared, pure event reducer. The UI (05), the evals (02) and the API (04) all fold the event log with
 * `applyEvent`; never write a second reducer.
 *
 * - Pure and deterministic: never mutates its input; returns a new projection (structural sharing).
 * - Idempotent for replays: events with `seq <= state.lastSeq` are ignored (duplicates).
 * - Forward-compatible: unknown event types only advance `lastSeq`/`simMinute`.
 * - Gaps are NOT detected here; the stream client (task 05) must re-fetch on a gap before applying.
 */
import type {
  AgentReportEvent,
  ApprovalScope,
  Assumption,
  Citation,
  DecisionOption,
  ProviderModel,
  RunLimits,
  RunTotals,
} from './common';
import { ZERO_TOTALS } from './common';
import {
  approvalStatusFor,
  type ApprovalDecisionKind,
  type ApprovalStatus,
  type RunEvent,
  type ScenarioAuthoringStatus,
} from './events';
import type { Actor, AgentRole, RunMode, RunStatus } from './ids';
import type { KpiSnapshot } from './kpi';
import { emptySystemState, type AnyEntity, type SystemState } from './systems';
import type { TwistEffect } from './scenario';

export type AgentStatus = 'running' | 'awaiting_approval' | 'done' | 'aborted';

export interface ProjectedAgent {
  agentRunId: string;
  role: AgentRole;
  parentAgentRunId?: string;
  brief: string;
  status: AgentStatus;
  startedSeq: number;
  lastSeq: number;
  iteration: number;
  toolCalls: number;
  lastThoughtSummary?: string;
  report?: AgentReportEvent;
  abortReason?: string;
  /** Pending approval ids raised by this agent. */
  pendingApprovalIds: string[];
}

export interface ProjectedApproval {
  approvalId: string;
  status: ApprovalStatus;
  agentRunId?: string;
  role?: AgentRole;
  toolCallId: string;
  tool: string;
  args: Record<string, unknown>;
  summary: string;
  reasoning: string;
  options?: DecisionOption[];
  expiresAtMinute?: number;
  proposalSeq: number;
  createdAtMinute: number;
  /** Additions (task 06): provenance and scope from the proposal. */
  unresolvedChecks?: string[];
  approvalScope?: ApprovalScope;
  citations?: Citation[];
  dataAsOfMinute?: number;
  assumptions?: Assumption[];
  /** This proposal revises an invalidated approval. */
  supersedesApprovalId?: string;
  /** Set by `approval.invalidated`: an assumption changed after the decision. */
  invalidated?: {
    seq: number;
    atMinute: number;
    affectedAssumptions: { key: string; was: unknown; now: unknown; source?: string }[];
  };
  /** Set when a later proposal supersedes this (invalidated) approval. */
  supersededBy?: string;
  decision?: {
    decision: ApprovalDecisionKind;
    editedArgs?: Record<string, unknown>;
    selectedOptionId?: string;
    reason?: string;
    decidedBy: Actor;
    seq: number;
    atMinute: number;
  };
}

export interface ProjectedTwist {
  seq: number;
  simMinute: number;
  twistId?: string;
  title: string;
  description: string;
  source: 'scheduled' | 'manual' | 'free_text';
  effects: TwistEffect[];
}

export interface ProjectedGuardrailBlock {
  seq: number;
  simMinute: number;
  agentRunId?: string;
  layer: string;
  tool?: string;
  reason: string;
  excerpt?: string;
  /** Additions (task 06). */
  toolCallId?: string;
  rule?: string;
  authority?: string;
  presenterTriggered?: boolean;
}

export interface RunProjection {
  runId: string | null;
  /** Highest seq applied (0 = empty). */
  lastSeq: number;
  meta: {
    scenarioId: string | null;
    mode: RunMode | null;
    pairedRunId?: string;
    status: RunStatus;
    speed: number;
    llm?: ProviderModel;
    limits?: RunLimits;
    completedReason?: 'report' | 'horizon' | 'stopped';
    error?: { error: string; where: string };
    createdSeq?: number;
    startedWallTime?: string;
    endedWallTime?: string;
    /** Addition (async authoring): the latest `scenario.authoring` (preparing the scenario from free text). */
    authoring?: { status: ScenarioAuthoringStatus; detail: string; seq: number };
    /**
     * Addition (self-recovery): the latest `run.recovering` / `run.resumed_after_error` ("Recovered from a system
     * error — resumed at m{atMinute}").
     */
    recovery?: {
      status: 'recovering' | 'resumed';
      attempt: number;
      reason?: string;
      atMinute: number;
      seq: number;
    };
  };
  simMinute: number;
  simTime: string | null;
  /** Per-system entity maps rebuilt from `system.mutation` events. */
  systems: SystemState;
  /** Last mutated entity (for the inspector's change highlight). */
  lastMutation: { seq: number; system: string; entity: string; id: string; op: string } | null;
  approvals: Record<string, ProjectedApproval>;
  /** Pending approval ids in proposal order. */
  pendingApprovalIds: string[];
  kpis: KpiSnapshot | null;
  agents: Record<string, ProjectedAgent>;
  twists: ProjectedTwist[];
  guardrailBlocks: ProjectedGuardrailBlock[];
  fallbacks: { seq: number; from: ProviderModel; to: ProviderModel; reason: string }[];
  baselineActions: number;
  /** Running totals from `usage` and tool calls; replaced by `run.completed.totals` at the end. */
  totals: RunTotals;
}

export function emptyProjection(runId: string | null = null): RunProjection {
  return {
    runId,
    lastSeq: 0,
    meta: { scenarioId: null, mode: null, status: 'created', speed: 6 },
    simMinute: 0,
    simTime: null,
    systems: emptySystemState(),
    lastMutation: null,
    approvals: {},
    pendingApprovalIds: [],
    kpis: null,
    agents: {},
    twists: [],
    guardrailBlocks: [],
    fallbacks: [],
    baselineActions: 0,
    totals: { ...ZERO_TOTALS },
  };
}

function updateAgent(
  s: RunProjection,
  agentRunId: string | undefined,
  seq: number,
  fn: (a: ProjectedAgent) => ProjectedAgent,
): RunProjection {
  if (!agentRunId) return s;
  const a = s.agents[agentRunId];
  if (!a) return s;
  return { ...s, agents: { ...s.agents, [agentRunId]: { ...fn(a), lastSeq: seq } } };
}

function setEntity(
  systems: SystemState,
  system: string,
  entity: string,
  id: string,
  value: AnyEntity | undefined,
): SystemState {
  const loose = systems as unknown as Record<string, Record<string, Record<string, AnyEntity>>>;
  const sys = loose[system] ?? {};
  const ent = { ...(sys[entity] ?? {}) };
  if (value === undefined) delete ent[id];
  else ent[id] = value;
  return { ...loose, [system]: { ...sys, [entity]: ent } } as unknown as SystemState;
}

/** Apply one event. Pure. */
export function applyEvent(state: RunProjection, e: RunEvent): RunProjection {
  if (e.seq <= state.lastSeq) return state;
  let s: RunProjection = {
    ...state,
    runId: state.runId ?? e.runId,
    lastSeq: e.seq,
    simMinute: Math.max(state.simMinute, e.simMinute),
    simTime: e.simMinute >= state.simMinute ? e.simTime : state.simTime,
  };
  if (e.usage) {
    s = {
      ...s,
      totals: {
        ...s.totals,
        inputTokens: s.totals.inputTokens + e.usage.inputTokens,
        outputTokens: s.totals.outputTokens + e.usage.outputTokens,
        costUsd: s.totals.costUsd + e.usage.costUsd,
      },
    };
  }

  switch (e.type) {
    case 'run.created': {
      const p = e.payload;
      return {
        ...s,
        meta: {
          ...s.meta,
          scenarioId: p.scenarioId,
          mode: p.mode,
          pairedRunId: p.pairedRunId,
          speed: p.speed,
          status: 'created',
          llm: { provider: p.config.provider as ProviderModel['provider'], model: p.config.model },
          limits: p.config.limits,
          createdSeq: e.seq,
        },
      };
    }
    case 'run.started':
      return {
        ...s,
        meta: { ...s.meta, status: 'running', speed: e.payload.speed, startedWallTime: e.wallTime },
      };
    case 'run.paused':
      return { ...s, meta: { ...s.meta, status: 'paused', speed: e.payload.speed } };
    case 'run.resumed':
      return { ...s, meta: { ...s.meta, status: 'running', speed: e.payload.speed } };
    case 'run.speed_changed':
      return { ...s, meta: { ...s.meta, speed: e.payload.speed } };
    case 'run.completed':
      return {
        ...s,
        meta: {
          ...s.meta,
          status: 'completed',
          completedReason: e.payload.reason,
          endedWallTime: e.wallTime,
        },
        totals: e.payload.totals,
        kpis: e.payload.finalKpis,
      };
    case 'run.recovering':
      return {
        ...s,
        meta: {
          ...s.meta,
          recovery: {
            status: 'recovering',
            attempt: e.payload.attempt,
            reason: e.payload.reason,
            atMinute: e.simMinute,
            seq: e.seq,
          },
        },
      };
    case 'run.resumed_after_error':
      return {
        ...s,
        meta: {
          ...s.meta,
          status: 'running',
          recovery: {
            status: 'resumed',
            attempt: e.payload.attempt,
            ...(s.meta.recovery?.reason ? { reason: s.meta.recovery.reason } : {}),
            atMinute: e.payload.fromMinute,
            seq: e.seq,
          },
        },
      };
    case 'run.failed':
      return {
        ...s,
        meta: { ...s.meta, status: 'failed', error: { ...e.payload }, endedWallTime: e.wallTime },
      };
    case 'world.tick':
      return { ...s, simMinute: Math.max(s.simMinute, e.payload.simMinute) };
    case 'world.twist':
      return {
        ...s,
        twists: [
          ...s.twists,
          {
            seq: e.seq,
            simMinute: e.simMinute,
            twistId: e.payload.twistId,
            title: e.payload.title,
            description: e.payload.description,
            source: e.payload.source,
            effects: e.payload.effects,
          },
        ],
      };
    case 'kpi.update':
      return { ...s, kpis: e.payload };
    case 'system.mutation': {
      const p = e.payload;
      const value = p.op === 'delete' ? undefined : (p.after as AnyEntity | undefined);
      if (p.op !== 'delete' && value === undefined) return s;
      return {
        ...s,
        systems: setEntity(s.systems, p.system, p.entity, p.id, value),
        lastMutation: { seq: e.seq, system: p.system, entity: p.entity, id: p.id, op: p.op },
      };
    }
    case 'agent.started': {
      if (!e.agentRunId) return s;
      const agent: ProjectedAgent = {
        agentRunId: e.agentRunId,
        role: e.payload.role,
        parentAgentRunId: e.payload.parentAgentRunId ?? e.parentAgentRunId,
        brief: e.payload.brief,
        status: 'running',
        startedSeq: e.seq,
        lastSeq: e.seq,
        iteration: 0,
        toolCalls: 0,
        pendingApprovalIds: [],
      };
      return { ...s, agents: { ...s.agents, [e.agentRunId]: agent } };
    }
    case 'agent.thought':
      s = { ...s, totals: { ...s.totals, iterations: s.totals.iterations + 1 } };
      return updateAgent(s, e.agentRunId, e.seq, (a) => ({
        ...a,
        iteration: e.iteration ?? a.iteration,
        lastThoughtSummary: e.payload.summary,
      }));
    case 'agent.tool_call':
      s = { ...s, totals: { ...s.totals, toolCalls: s.totals.toolCalls + 1 } };
      return updateAgent(s, e.agentRunId, e.seq, (a) => ({
        ...a,
        iteration: e.iteration ?? a.iteration,
        toolCalls: a.toolCalls + 1,
      }));
    case 'agent.tool_result':
      return updateAgent(s, e.agentRunId, e.seq, (a) => a);
    case 'agent.proposal': {
      const p = e.payload;
      const agent = e.agentRunId ? s.agents[e.agentRunId] : undefined;
      const approval: ProjectedApproval = {
        approvalId: p.approvalId,
        status: 'pending',
        agentRunId: e.agentRunId,
        role: agent?.role ?? (e.actor.kind === 'agent' ? e.actor.role : undefined),
        toolCallId: p.toolCallId,
        tool: p.tool,
        args: p.args,
        summary: p.summary,
        reasoning: p.reasoning,
        options: p.options,
        expiresAtMinute: p.expiresAtMinute,
        proposalSeq: e.seq,
        createdAtMinute: e.simMinute,
        ...(p.unresolvedChecks ? { unresolvedChecks: p.unresolvedChecks } : {}),
        ...(p.approvalScope ? { approvalScope: p.approvalScope } : {}),
        ...(p.citations ? { citations: p.citations } : {}),
        ...(p.dataAsOfMinute !== undefined ? { dataAsOfMinute: p.dataAsOfMinute } : {}),
        ...(p.assumptions ? { assumptions: p.assumptions } : {}),
        ...(p.supersedesApprovalId ? { supersedesApprovalId: p.supersedesApprovalId } : {}),
      };
      const superseded = p.supersedesApprovalId ? s.approvals[p.supersedesApprovalId] : undefined;
      if (superseded)
        s = {
          ...s,
          approvals: {
            ...s.approvals,
            [superseded.approvalId]: { ...superseded, supersededBy: p.approvalId },
          },
        };
      s = {
        ...s,
        approvals: { ...s.approvals, [p.approvalId]: approval },
        pendingApprovalIds: [...s.pendingApprovalIds.filter((id) => id !== p.approvalId), p.approvalId],
      };
      return updateAgent(s, e.agentRunId, e.seq, (a) => ({
        ...a,
        status: a.status === 'running' ? 'awaiting_approval' : a.status,
        pendingApprovalIds: [...a.pendingApprovalIds, p.approvalId],
      }));
    }
    case 'approval.decision': {
      const p = e.payload;
      const existing = s.approvals[p.approvalId];
      if (!existing) return s;
      const approval: ProjectedApproval = {
        ...existing,
        status: approvalStatusFor(p.decision),
        decision: {
          decision: p.decision,
          editedArgs: p.editedArgs,
          selectedOptionId: p.selectedOptionId,
          reason: p.reason,
          decidedBy: p.decidedBy,
          seq: e.seq,
          atMinute: e.simMinute,
        },
      };
      s = {
        ...s,
        approvals: { ...s.approvals, [p.approvalId]: approval },
        pendingApprovalIds: s.pendingApprovalIds.filter((id) => id !== p.approvalId),
      };
      return updateAgent(s, existing.agentRunId, e.seq, (a) => {
        const pending = a.pendingApprovalIds.filter((id) => id !== p.approvalId);
        return {
          ...a,
          pendingApprovalIds: pending,
          status: a.status === 'awaiting_approval' && pending.length === 0 ? 'running' : a.status,
        };
      });
    }
    case 'approval.invalidated': {
      const existing = s.approvals[e.payload.approvalId];
      if (!existing) return s;
      return {
        ...s,
        approvals: {
          ...s.approvals,
          [existing.approvalId]: {
            ...existing,
            invalidated: {
              seq: e.seq,
              atMinute: e.simMinute,
              affectedAssumptions: e.payload.affectedAssumptions,
            },
          },
        },
      };
    }
    case 'agent.report':
      return updateAgent(s, e.agentRunId, e.seq, (a) => ({ ...a, status: 'done', report: e.payload.report }));
    case 'agent.aborted':
      return updateAgent(s, e.agentRunId, e.seq, (a) => ({
        ...a,
        status: 'aborted',
        abortReason: `${e.payload.reason}: ${e.payload.detail}`,
      }));
    case 'guardrail.blocked':
      return {
        ...s,
        guardrailBlocks: [
          ...s.guardrailBlocks,
          {
            seq: e.seq,
            simMinute: e.simMinute,
            agentRunId: e.agentRunId,
            layer: e.payload.layer,
            tool: e.payload.tool,
            reason: e.payload.reason,
            excerpt: e.payload.excerpt,
            ...(e.payload.toolCallId ? { toolCallId: e.payload.toolCallId } : {}),
            ...(e.payload.rule ? { rule: e.payload.rule } : {}),
            ...(e.payload.authority ? { authority: e.payload.authority } : {}),
            ...(e.payload.presenterTriggered ? { presenterTriggered: true } : {}),
          },
        ],
      };
    case 'baseline.action':
      return { ...s, baselineActions: s.baselineActions + 1 };
    case 'llm.fallback':
      return {
        ...s,
        meta: { ...s.meta, llm: e.payload.to },
        fallbacks: [...s.fallbacks, { seq: e.seq, ...e.payload }],
      };
    case 'scenario.authoring':
      return {
        ...s,
        meta: { ...s.meta, authoring: { status: e.payload.status, detail: e.payload.detail, seq: e.seq } },
      };
    default:
      // twist.requested, control.requested, world.process and future types: no projected state.
      return s;
  }
}

/** Fold a list of events (in seq order) into a projection. */
export function foldEvents(
  events: readonly RunEvent[],
  initial: RunProjection = emptyProjection(),
): RunProjection {
  let s = initial;
  for (const e of events) s = applyEvent(s, e);
  return s;
}
