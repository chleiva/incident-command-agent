/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Pure view-model derivations over the event array and the reducer projection. No state of their own: the
 * projection comes from the shared reducer; these only shape it for the zones.
 */
import type {
  AgentReportEvent,
  AgentRole,
  Engineer,
  EngineeringDecision,
  EventPayloadMap,
  KpiSnapshot,
  ProjectedApproval,
  ProvisionalReading,
  RunEvent,
  RunProjection,
} from '@ica/schema/browser';

// ------------------------------------------------------------------------------------------------ KPI series
export interface KpiPoint {
  seq: number;
  minute: number;
  kpis: KpiSnapshot;
}

export function kpiSeries(events: readonly RunEvent[]): KpiPoint[] {
  const out: KpiPoint[] = [];
  for (const e of events) {
    if (e.type === 'kpi.update') out.push({ seq: e.seq, minute: e.simMinute, kpis: e.payload });
    else if (e.type === 'run.completed')
      out.push({ seq: e.seq, minute: e.simMinute, kpis: e.payload.finalKpis });
  }
  return out;
}

/** The KPI snapshot of a (baseline) series at or before a sim minute. */
export function kpiAtMinute(series: readonly KpiPoint[], minute: number): KpiSnapshot | null {
  let found: KpiSnapshot | null = null;
  for (const p of series) {
    if (p.minute <= minute) found = p.kpis;
    else break;
  }
  return found;
}

// ------------------------------------------------------------------------------------------------ timeline markers
export type MarkerKind =
  | 'trigger'
  | 'proposal'
  | 'decision'
  | 'message'
  | 'twist'
  | 'blocked'
  | 'end'
  | 'baseline'
  | 'recovery'
  | 'failed';

export interface Marker {
  seq: number;
  minute: number;
  kind: MarkerKind;
  label: string;
}

export function eventMarkers(events: readonly RunEvent[]): Marker[] {
  const out: Marker[] = [];
  const proposals = new Map<string, string>();
  let trigger = false;
  for (const e of events) {
    const m = { seq: e.seq, minute: e.simMinute };
    switch (e.type) {
      case 'system.mutation': {
        const p = e.payload;
        if (!trigger && p.system === 'mne' && p.entity === 'defects' && p.op === 'create') {
          trigger = true;
          out.push({
            ...m,
            kind: 'trigger',
            label: `Trigger: ${String((p.after as { description?: string })?.description ?? 'incident')}`,
          });
        }
        if (p.system === 'pss' && p.entity === 'messages') {
          const after = p.after as { status?: string; cohortIds?: string[] } | undefined;
          const before = p.before as { status?: string } | undefined;
          if (after?.status === 'sent' && before?.status !== 'sent') {
            out.push({ ...m, kind: 'message', label: 'Passenger message sent' });
          }
        }
        break;
      }
      case 'agent.proposal':
        proposals.set(e.payload.approvalId, e.payload.tool.replace(/_/g, ' '));
        out.push({ ...m, kind: 'proposal', label: `Decision requested: ${e.payload.summary}` });
        break;
      case 'approval.decision': {
        const verb =
          e.payload.decision === 'approve'
            ? 'Approved'
            : e.payload.decision === 'edit'
              ? 'Edited and approved'
              : 'Rejected';
        const what = proposals.get(e.payload.approvalId);
        out.push({ ...m, kind: 'decision', label: `${verb}${what ? `: ${what}` : ''}` });
        break;
      }
      case 'world.twist':
        out.push({ ...m, kind: 'twist', label: `Twist: ${e.payload.title}` });
        break;
      case 'guardrail.blocked':
        out.push({ ...m, kind: 'blocked', label: `Blocked: ${e.payload.tool ?? e.payload.layer}` });
        break;
      case 'run.completed':
        out.push({
          ...m,
          kind: 'end',
          label: e.payload.reason === 'stopped' ? 'Run stopped (kill switch)' : 'Run complete',
        });
        break;
      case 'run.failed':
        out.push({ ...m, kind: 'failed', label: 'Run stopped: system error' });
        break;
      case 'baseline.action':
        out.push({
          ...m,
          kind: 'baseline',
          label: `Baseline: ${e.payload.actor} — ${e.payload.tool.replace(/_/g, ' ')}`,
        });
        break;
      default: {
        // Self-recovery (additive, optional events): read by type name.
        const type = e.type as string;
        if (type === 'run.recovering') {
          const attempt = (e.payload as { attempt?: unknown }).attempt;
          out.push({
            ...m,
            kind: 'recovery',
            label: `System error — recovering${typeof attempt === 'number' ? ` (attempt ${attempt})` : ''}`,
          });
        } else if (type === 'run.resumed_after_error') {
          out.push({ ...m, kind: 'recovery', label: 'Resumed after a system error' });
        }
        break;
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ agent feed
type Payload<T extends keyof EventPayloadMap> = EventPayloadMap[T];

interface FeedBase {
  key: string;
  seq: number;
  minute: number;
  agentRunId?: string;
  role: AgentRole | 'world';
}

export interface ToolFeedItem extends FeedBase {
  kind: 'tool';
  thought?: { summary: string; text: string; latencyMs?: number };
  call: Payload<'agent.tool_call'>;
  result?: Payload<'agent.tool_result'> & { latencyMs?: number; seq: number };
  blocked?: Payload<'guardrail.blocked'> & { seq: number };
  proposal?: Payload<'agent.proposal'> & { seq: number };
  decision?: Payload<'approval.decision'> & { seq: number };
}

export type FeedItem =
  | ToolFeedItem
  | (FeedBase & { kind: 'thought'; summary: string; text: string })
  | (FeedBase & { kind: 'started'; brief: string })
  | (FeedBase & { kind: 'report'; report: AgentReportEvent })
  | (FeedBase & { kind: 'aborted'; reason: string })
  | (FeedBase & { kind: 'blocked'; block: Payload<'guardrail.blocked'> })
  | (FeedBase & {
      kind: 'invalidated';
      invalidation: Payload<'approval.invalidated'>;
      /** Summary and tool of the invalidated proposal. */
      proposal?: { summary: string; tool: string };
    });

export type FeedFilter = 'all' | 'tools' | 'thinking' | 'decisions' | 'blocks' | 'reports';

export function agentFeed(events: readonly RunEvent[]): FeedItem[] {
  const items: FeedItem[] = [];
  const pendingThought = new Map<
    string,
    { seq: number; minute: number; role: AgentRole; summary: string; text: string; latencyMs?: number }
  >();
  const byCall = new Map<string, ToolFeedItem>();
  const byApproval = new Map<string, ToolFeedItem>();
  const roleOf = (e: RunEvent): AgentRole | 'world' => (e.actor.kind === 'agent' ? e.actor.role : 'world');

  const flushThought = (agentRunId: string) => {
    const t = pendingThought.get(agentRunId);
    if (!t) return;
    pendingThought.delete(agentRunId);
    items.push({
      kind: 'thought',
      key: `th-${t.seq}`,
      seq: t.seq,
      minute: t.minute,
      agentRunId,
      role: t.role,
      summary: t.summary,
      text: t.text,
    });
  };

  for (const e of events) {
    const base = { seq: e.seq, minute: e.simMinute, agentRunId: e.agentRunId, role: roleOf(e) };
    switch (e.type) {
      case 'agent.started':
        items.push({
          ...base,
          kind: 'started',
          key: `st-${e.seq}`,
          role: e.payload.role,
          brief: e.payload.brief,
        });
        break;
      case 'agent.thought': {
        if (!e.agentRunId || e.actor.kind !== 'agent') break;
        flushThought(e.agentRunId);
        pendingThought.set(e.agentRunId, {
          seq: e.seq,
          minute: e.simMinute,
          role: e.actor.role,
          summary: e.payload.summary,
          text: e.payload.text,
          latencyMs: e.latencyMs,
        });
        break;
      }
      case 'agent.tool_call': {
        const t = e.agentRunId ? pendingThought.get(e.agentRunId) : undefined;
        if (t && e.agentRunId) pendingThought.delete(e.agentRunId);
        const item: ToolFeedItem = {
          ...base,
          kind: 'tool',
          key: `tc-${e.seq}`,
          call: e.payload,
          ...(t ? { thought: { summary: t.summary, text: t.text, latencyMs: t.latencyMs } } : {}),
        };
        byCall.set(e.payload.toolCallId, item);
        items.push(item);
        break;
      }
      case 'agent.tool_result': {
        const item = byCall.get(e.payload.toolCallId);
        if (item) item.result = { ...e.payload, latencyMs: e.latencyMs, seq: e.seq };
        break;
      }
      case 'guardrail.blocked': {
        const item = e.payload.toolCallId ? byCall.get(e.payload.toolCallId) : undefined;
        if (item) item.blocked = { ...e.payload, seq: e.seq };
        else items.push({ ...base, kind: 'blocked', key: `bl-${e.seq}`, block: e.payload });
        break;
      }
      case 'agent.proposal': {
        const item = byCall.get(e.payload.toolCallId);
        if (item) {
          item.proposal = { ...e.payload, seq: e.seq };
          byApproval.set(e.payload.approvalId, item);
        }
        break;
      }
      case 'approval.decision': {
        const item = byApproval.get(e.payload.approvalId);
        if (item) item.decision = { ...e.payload, seq: e.seq };
        break;
      }
      case 'approval.invalidated': {
        const item = byApproval.get(e.payload.approvalId);
        items.push({
          ...base,
          role: e.payload.role ?? (item?.role as AgentRole | undefined) ?? 'world',
          kind: 'invalidated',
          key: `iv-${e.seq}`,
          invalidation: e.payload,
          ...(item?.proposal
            ? { proposal: { summary: item.proposal.summary, tool: item.proposal.tool } }
            : {}),
        });
        break;
      }
      case 'agent.report':
        if (e.agentRunId) flushThought(e.agentRunId);
        items.push({
          ...base,
          kind: 'report',
          key: `rp-${e.seq}`,
          role: e.payload.role,
          report: e.payload.report,
        });
        break;
      case 'agent.aborted':
        items.push({
          ...base,
          kind: 'aborted',
          key: `ab-${e.seq}`,
          role: e.payload.role,
          reason: `${e.payload.reason}: ${e.payload.detail}`,
        });
        break;
      default:
        break;
    }
  }
  for (const id of [...pendingThought.keys()]) flushThought(id);
  return items.sort((a, b) => a.seq - b.seq);
}

export function matchesFilter(item: FeedItem, filter: FeedFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'tools':
      return item.kind === 'tool';
    case 'thinking':
      return item.kind === 'thought' || (item.kind === 'tool' && !!item.thought);
    case 'decisions':
      return (item.kind === 'tool' && !!item.proposal) || item.kind === 'invalidated';
    case 'blocks':
      return item.kind === 'blocked' || (item.kind === 'tool' && !!item.blocked);
    case 'reports':
      return item.kind === 'report' || item.kind === 'aborted';
  }
}

// ------------------------------------------------------------------------------------------------ decisions
/** Pending approvals, most urgent first: those with an expiry (soonest first), then oldest first. */
export function pendingByUrgency(view: RunProjection): ProjectedApproval[] {
  return view.pendingApprovalIds
    .map((id) => view.approvals[id])
    .filter((a): a is ProjectedApproval => !!a)
    .sort((a, b) => {
      const ea = a.expiresAtMinute ?? Number.POSITIVE_INFINITY;
      const eb = b.expiresAtMinute ?? Number.POSITIVE_INFINITY;
      if (ea !== eb) return ea - eb;
      return a.createdAtMinute - b.createdAtMinute;
    });
}

/** Approvals invalidated by a changed assumption whose revision has not been decided yet (shown as notices). */
export function openInvalidations(view: RunProjection): ProjectedApproval[] {
  return Object.values(view.approvals)
    .filter((a) => {
      if (!a.invalidated) return false;
      const revision = a.supersededBy ? view.approvals[a.supersededBy] : undefined;
      return !revision || revision.status === 'pending';
    })
    .sort((a, b) => (a.invalidated?.seq ?? 0) - (b.invalidated?.seq ?? 0));
}

/** The latest provisional reading of the defect from a maintenance report (a model reading, never a status). */
export function latestProvisionalReading(
  view: RunProjection,
): { reading: ProvisionalReading; agentRunId: string } | null {
  let best: { reading: ProvisionalReading; agentRunId: string; seq: number } | null = null;
  for (const a of Object.values(view.agents)) {
    const reading = a.role === 'maintenance' ? a.report?.provisionalReading : undefined;
    if (reading && (!best || a.lastSeq > best.seq))
      best = { reading, agentRunId: a.agentRunId, seq: a.lastSeq };
  }
  return best ? { reading: best.reading, agentRunId: best.agentRunId } : null;
}

/**
 * The latest engineering decision recorded with `record_engineering_decision` (the only source of "Decided by":
 * its `decidedBy` is the approving human). Never derived from agent text.
 */
export function latestEngineeringDecision(view: RunProjection, tail?: string): EngineeringDecision | null {
  const all = Object.values(view.systems.mne.decisions).filter(
    (d) => d.decidedBy.kind === 'human' && (!tail || d.tail === tail),
  );
  return all.sort((a, b) => b.atMinute - a.atMinute)[0] ?? null;
}

export function decidedApprovals(view: RunProjection): ProjectedApproval[] {
  return Object.values(view.approvals)
    .filter((a) => a.decision)
    .sort((a, b) => (b.decision?.seq ?? 0) - (a.decision?.seq ?? 0));
}

// ------------------------------------------------------------------------------------------------ ground view
/** Sim minute at which each engineer last started travelling (for the ETA path). */
export function travelStarts(events: readonly RunEvent[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of events) {
    if (e.type !== 'system.mutation' || e.payload.system !== 'engineers') continue;
    const after = e.payload.after as Partial<Engineer> | undefined;
    const before = e.payload.before as Partial<Engineer> | undefined;
    if (after?.status === 'travelling' && before?.status !== 'travelling') out[e.payload.id] = e.simMinute;
  }
  return out;
}

/** 0 = just paged, 1 = on site. */
export function engineerProgress(eng: Engineer, startMinute: number | undefined, simMinute: number): number {
  if (eng.status === 'on_site' || eng.status === 'busy') return 1;
  if (eng.status !== 'travelling' || eng.etaMinute === undefined || startMinute === undefined) return 0;
  const span = Math.max(0.5, eng.etaMinute - startMinute);
  return Math.min(0.97, Math.max(0, (simMinute - startMinute) / span));
}

/** Rows touched by the latest mutation (inspector highlight): `${system}/${entity}/${id}` → seq. */
export function recentMutations(events: readonly RunEvent[], windowSize = 6): Map<string, number> {
  const out = new Map<string, number>();
  for (let i = events.length - 1; i >= 0 && out.size < windowSize; i--) {
    const e = events[i]!;
    if (e.type !== 'system.mutation') continue;
    const k = `${e.payload.system}/${e.payload.entity}/${e.payload.id}`;
    if (!out.has(k)) out.set(k, e.seq);
  }
  return out;
}

/** Roles currently working (between agent.started and agent.report). */
export function activeRoles(
  view: RunProjection,
): Map<AgentRole, 'running' | 'awaiting_approval' | 'done' | 'aborted'> {
  const out = new Map<AgentRole, 'running' | 'awaiting_approval' | 'done' | 'aborted'>();
  const rank = { aborted: 0, done: 1, running: 2, awaiting_approval: 3 } as const;
  for (const a of Object.values(view.agents)) {
    const cur = out.get(a.role);
    if (!cur || rank[a.status] > rank[cur]) out.set(a.role, a.status);
  }
  return out;
}
