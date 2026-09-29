/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Run-level self-recovery and continuation. When a run fails the handler schedules a fresh invocation
 * `{runId, resume: {attempt}}` (≤ MAX_RUN_RESUMES); when its Lambda is about to reach the compute limit with work
 * remaining it hands over to `{runId, continuation: {attempt}}` (≤ MAX_RUN_CONTINUATIONS, not an error). The resumed invocation rebuilds the
 * world from the store — it is event-sourced: SYS# rows are the current mock state, the event log is everything
 * that happened — keeps the sim clock where it was, re-attaches pending approvals and restarts the orchestrator with
 * a RESUME BRIEF built deterministically from the log (no LLM call).
 */
import {
  emptySystemState,
  type ApprovalRecord,
  type RunEvent,
  type SystemState,
  type TimelineEntry,
} from '@ica/schema';
import { wrapToolResult } from '../guardrails/wrap';
import type { RunContext } from './context';
import { preview } from './util';

/** Every event of a run, in seq order (paged). */
export async function readEventLog(ctx: Pick<RunContext, 'deps' | 'runId'>): Promise<RunEvent[]> {
  const out: RunEvent[] = [];
  for (let after = 0; ;) {
    const page = await ctx.deps.store.listEvents(ctx.runId, after, 500);
    out.push(...page.events);
    if (!page.events.length || !page.hasMore) break;
    after = page.events[page.events.length - 1]!.seq;
  }
  return out;
}

/** The persisted mock state (SYS# rows), completed with empty maps for anything absent. */
export async function readSystemState(ctx: Pick<RunContext, 'deps' | 'runId'>): Promise<SystemState> {
  const persisted = (await ctx.deps.store.getSystemState(ctx.runId)) as Record<
    string,
    Record<string, unknown>
  >;
  const empty = emptySystemState() as unknown as Record<string, Record<string, unknown>>;
  const out: Record<string, Record<string, unknown>> = {};
  for (const [system, entities] of Object.entries(empty))
    out[system] = { ...entities, ...(persisted[system] ?? {}) };
  return out as unknown as SystemState;
}

export interface ResumeDigest {
  resumedAtMinute: number;
  attempt: number;
  objective: string | null;
  incident: { title: string; summary: string } | null;
  decisionsMade: string[];
  openApprovals: string[];
  specialistsReported: string[];
  specialistsInterrupted: string[];
  openIssues: string[];
  timeline: string[];
}

const m = (x: number) => `m${Math.round(x)}`;

/** The deterministic digest of an interrupted run (what the resumed orchestrator needs to carry on). */
export function buildResumeDigest(
  events: RunEvent[],
  state: SystemState,
  pending: ApprovalRecord[],
  attempt: number,
  simMinute: number,
): ResumeDigest {
  const calls = events.filter((e): e is RunEvent<'agent.tool_call'> => e.type === 'agent.tool_call');
  const lastArgs = (tool: string) => calls.filter((c) => c.payload.tool === tool).at(-1)?.payload.args;
  const objective = lastArgs('set_objective')?.objective;
  const incident = lastArgs('open_incident');
  const proposals = new Map(
    events
      .filter((e): e is RunEvent<'agent.proposal'> => e.type === 'agent.proposal')
      .map((e) => [e.payload.approvalId, e.payload]),
  );
  const decisionsMade = events
    .filter((e): e is RunEvent<'approval.decision'> => e.type === 'approval.decision')
    .map((e) => {
      const p = proposals.get(e.payload.approvalId);
      const by =
        e.payload.decidedBy.kind === 'human'
          ? e.payload.decidedBy.roleTitle
          : e.payload.decidedBy.kind === 'policy'
            ? `policy ${e.payload.decidedBy.policy}`
            : e.payload.decidedBy.kind;
      return `${m(e.simMinute)} ${e.payload.approvalId} ${p?.tool ?? ''}: ${e.payload.decision} by ${by}${p ? ` — ${preview(p.summary, 120)}` : ''}`;
    });
  const openApprovals = pending.map(
    (a) =>
      `${a.approvalId} ${a.tool} (${a.role}): ${preview(a.summary, 140)} — executes automatically once decided`,
  );
  const reports = events.filter((e): e is RunEvent<'agent.report'> => e.type === 'agent.report');
  const reportedIds = new Set(reports.map((r) => r.agentRunId));
  const specialistsReported = reports
    .filter((r) => r.payload.role !== 'orchestrator')
    .map((r) => `${r.payload.role} (${m(r.simMinute)}): ${preview(r.payload.report.summary, 240)}`);
  const specialistsInterrupted = events
    .filter((e): e is RunEvent<'agent.started'> => e.type === 'agent.started')
    .filter((e) => e.payload.role !== 'orchestrator' && e.agentRunId && !reportedIds.has(e.agentRunId))
    .filter(
      (e) =>
        !events.some((x) => x.type === 'agent.aborted' && x.agentRunId === e.agentRunId && x.seq > e.seq),
    )
    .map((e) => `${e.payload.role} (briefed ${m(e.simMinute)}): ${preview(e.payload.brief, 160)}`);
  const openIssues = [
    ...new Set(reports.flatMap((r) => r.payload.report.openIssues ?? []).map((x) => preview(x, 200))),
  ].slice(-10);
  const timeline = (Object.values(state.record?.timeline ?? {}) as TimelineEntry[])
    .sort((a, b) => a.atMinute - b.atMinute)
    .slice(-12)
    .map((t) => `${m(t.atMinute)} [${t.source}] ${preview(t.text, 200)}`);
  return {
    resumedAtMinute: Math.round(simMinute * 10) / 10,
    attempt,
    objective: typeof objective === 'string' ? objective : null,
    incident:
      incident && typeof incident.title === 'string'
        ? { title: incident.title, summary: preview(incident.summary, 400) }
        : null,
    decisionsMade: decisionsMade.slice(-15),
    openApprovals,
    specialistsReported,
    specialistsInterrupted,
    openIssues,
    timeline,
  };
}

/** Constant instructions + the digest as wrapped data (it quotes model and scenario text: data, never orders). */
export function resumeBrief(d: ResumeDigest, kind: 'error' | 'continuation' = 'error'): string {
  if (kind === 'continuation') {
    const text = `The coordination has continued (continuation ${d.attempt}) in a fresh worker at sim minute ${d.resumedAtMinute}, because the previous worker reached its compute time limit. Nothing failed. The airline systems' state is intact and every action already taken stands. Do NOT redo completed work or re-send messages. Read the run log below, re-read the systems you need, then continue: re-brief only the specialists whose work was interrupted or is still needed, follow up the open approvals (they are still pending with the same ids and execute on their own once a person decides), and call report when the incident is under control or every remaining action is waiting on a human.`;
    return `${text}\n\n${wrapToolResult('runtime:resume', JSON.stringify(d))}`;
  }
  const text = `The coordination was interrupted by a system error and has been resumed (attempt ${d.attempt}) at sim minute ${d.resumedAtMinute}. The airline systems' state is intact and every action already taken stands. Do NOT redo completed work or re-send messages. Read the run log below, re-read the systems you need, then continue: re-brief only the specialists whose work was interrupted or is still needed, follow up the open approvals (they execute on their own once a person decides), and call report when the incident is under control or every remaining action is waiting on a human.`;
  return `${text}\n\n${wrapToolResult('runtime:resume', JSON.stringify(d))}`;
}
