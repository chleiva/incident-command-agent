/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * The Agents view model (task 08), derived in the browser from the run's event log only: one column per agent
 * role, one row per action. Human decisions, the wait for them, withdrawn approvals and terminal stops are rows of
 * their own, never hidden inside an expanded proposal. Pure functions; no state.
 */
import type {
  Actor,
  AgentReportEvent,
  AgentRole,
  EventPayloadMap,
  RunEvent,
  RunLimits,
  RunProjection,
} from '@ica/schema/browser';
import { clipText, fitHeadline, headline, HEADLINE_MAX, resultData, toolLabel } from './headline';
import { ROLE_ORDER, roleShortName } from './roles';

type P<T extends keyof EventPayloadMap> = EventPayloadMap[T];

export type RowKind =
  | 'brief'
  | 'thought'
  | 'tool'
  | 'proposal'
  | 'waiting'
  | 'decision'
  | 'invalidated'
  | 'blocked'
  | 'stopped'
  | 'report'
  /** The run resumed after a system error (additive `run.resumed_after_error`); shown in the orchestrator column. */
  | 'recovery';

export type RowTier = 'executed' | 'proposed' | 'blocked';

export interface AgentRow {
  /** Stable key (row kind + source seq). */
  key: string;
  kind: RowKind;
  /** The seq of the event the row stands for: selecting the row moves the scrubber here. */
  seq: number;
  minute: number;
  role: AgentRole;
  agentRunId: string;
  /** `iteration + 1` of the agent's turn within its agent run (parallel calls in one turn share it). */
  turn?: number;
  /**
   * The turn number shown (T1…Tn): continuous per column across re-briefs (several agent runs of one role), so the
   * second brief's first turn follows the first brief's last turn.
   */
  columnTurn?: number;
  /** Brief rows of the 2nd+ agent run of a role: the re-brief number (a divider row, "Re-brief 2 from …"). */
  rebrief?: number;
  /** Tool rows: later identical calls answered with this row's result (deduplicated/cached), not rows of their own. */
  reused?: number;
  headline: string;
  tier?: RowTier;
  /** A tool result came back as an error (not a guardrail block). */
  failed?: boolean;
  thought?: { text: string; summary: string };
  call?: P<'agent.tool_call'> & { seq: number };
  result?: P<'agent.tool_result'> & { seq: number };
  proposal?: P<'agent.proposal'> & { seq: number };
  decision?: P<'approval.decision'> & { seq: number; minute: number };
  block?: P<'guardrail.blocked'> & { seq: number };
  flags?: (P<'guardrail.flagged'> & { seq: number })[];
  report?: AgentReportEvent;
  aborted?: P<'agent.aborted'>;
  invalidation?: P<'approval.invalidated'>;
  brief?: string;
  approvalId?: string;
  /** Waiting rows: the approval is still pending in the log. */
  pending?: boolean;
  /** Delegation: the paired row in the other column ("→ briefed X" ↔ "← brief from Orchestrator"). */
  link?: { targetKey: string; direction: 'out' | 'in'; role: AgentRole };
}

export type ColumnStatus = 'working' | 'waiting' | 'blocked' | 'done';

export interface AgentColumn {
  role: AgentRole;
  agentRunIds: string[];
  rows: AgentRow[];
  firstSeq: number;
}

export interface AuthoringStep {
  seq: number;
  minute: number;
  status: P<'scenario.authoring'>['status'];
  detail: string;
  errors?: string[];
}

export interface AuthorBanner {
  /** The one line shown collapsed. */
  line: string;
  status: AuthoringStep['status'];
  steps: AuthoringStep[];
  /** Rows of an author agent, when the log carries its steps. */
  rows: AgentRow[];
}

export interface AgentRunInfo {
  agentRunId: string;
  role: AgentRole;
  brief: string;
  parentAgentRunId?: string;
  startedSeq: number;
  rows: AgentRow[];
  /** Reports of the agents this one briefed (the orchestrator's view), with the seq they arrived at. */
  childReports: { seq: number; role: AgentRole; report: AgentReportEvent }[];
}

export interface AgentsModel {
  columns: AgentColumn[];
  author: AuthorBanner | null;
  rowByKey: Map<string, AgentRow>;
  runs: Map<string, AgentRunInfo>;
}

// ------------------------------------------------------------------------------------------------ row headlines
const LAYER_LABEL: Record<string, string> = {
  tier: 'reserved for people',
  input_screen: 'input screened out',
  output_screen: 'text screened out',
  arg_validation: 'invalid details',
  ref_validation: 'unknown reference',
};

/** "engineerEtaMinute" → "engineer ETA". */
export function assumptionLabel(key: string): string {
  const s = key
    .replace(/(Minute|Min|At)$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .toLowerCase()
    .replace(/\beta\b/g, 'ETA')
    .replace(/\bfdp\b/g, 'FDP')
    .trim();
  return s || 'an assumption';
}

function assumptionValue(key: string, v: unknown): string {
  if (typeof v === 'number')
    return /(Minute|At)$/.test(key) ? `m${Math.round(v)}` : String(Math.round(v * 10) / 10);
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (v === null || v === undefined) return 'none';
  return clipText(String(v), 14);
}

export function invalidationHeadline(inv: P<'approval.invalidated'>): string {
  const first = inv.affectedAssumptions[0];
  if (!first) return 'Approval withdrawn: an assumption changed';
  const change = ` changed (${assumptionValue(first.key, first.was)} → ${assumptionValue(first.key, first.now)})`;
  const more = inv.affectedAssumptions.length > 1 ? ` +${inv.affectedAssumptions.length - 1}` : '';
  const prefix = 'Approval withdrawn: ';
  const room = HEADLINE_MAX - prefix.length - change.length - more.length;
  return fitHeadline(`${prefix}${clipText(assumptionLabel(first.key), Math.max(6, room))}${change}${more}`);
}

function deciderTitle(a: Actor): string {
  switch (a.kind) {
    case 'human':
      return a.roleTitle || a.name;
    case 'policy':
      return a.policy === 'baseline' ? 'the baseline policy' : 'the eval auto-approver';
    case 'agent':
      return `the ${roleShortName(a.role)} agent`;
    default:
      return 'the system';
  }
}

export function decisionHeadline(d: P<'approval.decision'>, minute: number): string {
  const when = ` at m${Math.round(minute)}`;
  // A simulation auto-approval never reads as a person.
  if (d.decidedBy.kind === 'policy' && d.decidedBy.policy === 'simulation-auto')
    return fitHeadline(`Auto-approved (simulation)${when}`);
  const who = deciderTitle(d.decidedBy);
  if (d.decision === 'reject') {
    const reason = d.reason?.trim();
    if (!reason) return fitHeadline(`Rejected by ${who}${when}`);
    const prefix = `Rejected by ${who} — `;
    return fitHeadline(`${prefix}${clipText(reason, Math.max(10, HEADLINE_MAX - prefix.length))}`);
  }
  return fitHeadline(`${d.decision === 'edit' ? 'Approved with edits by' : 'Approved by'} ${who}${when}`);
}

export function stopHeadline(a: P<'agent.aborted'>, limits?: Partial<RunLimits>): string {
  switch (a.reason) {
    case 'tool_calls': {
      const n = limits?.maxToolCallsPerAgent || limits?.maxToolCallsPerRun || 60;
      return `Stopped: reached the ${n} tool-call limit for this agent`;
    }
    case 'iterations':
      return `Stopped: ${limits?.maxIterationsPerAgent ?? 25} steps without finishing`;
    case 'wall_clock':
      return 'Stopped: run time limit';
    case 'tokens':
      return 'Stopped: token limit reached';
    case 'budget':
      return 'Stopped: budget limit reached';
    case 'stopped':
      return 'Stopped: the run was stopped';
    default: {
      const prefix = 'Stopped: system error — ';
      return fitHeadline(`${prefix}${clipText(a.detail || 'unknown', HEADLINE_MAX - prefix.length)}`);
    }
  }
}

export function waitingHeadline(tool: string): string {
  return fitHeadline(`Waiting for a decision: ${toolLabel(tool)}`);
}

export const THOUGHT_HEADLINE = 'Reasoned about next steps';

export const RECOVERY_HEADLINE = 'Resumed after a system error — re-briefed from the record';

/** A tool error that says the system could not record the action (a store failure, not the agent's mistake). */
export function isRecordingFailure(preview: string | undefined): boolean {
  return /could not (be )?record|couldn.t record|not recorded/i.test(preview ?? '');
}

/** The call is marked as answered from an earlier identical call (additive markers, read defensively). */
function reuseMarker(p: Record<string, unknown>): { from?: string } | null {
  const from = [p.deduplicatedFrom, p.cachedFrom, p.reusedFrom].find(
    (x): x is string => typeof x === 'string' && !!x,
  );
  if (from) return { from };
  return p.deduplicated === true || p.cached === true || p.reused === true ? {} : null;
}

const sameArgs = (a: unknown, b: unknown) => {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
};

export function reportHeadline(report: AgentReportEvent): string {
  const n = report.openIssues?.length ?? 0;
  return `Finished — ${n === 0 ? 'no open issues' : `${n} open issue${n === 1 ? '' : 's'}`}`;
}

export function authoringLine(status: AuthoringStep['status'], detail: string): string {
  if (status === 'patched') return 'Scenario enriched from your description';
  if (status === 'started') return 'Preparing the scenario from your description…';
  return detail || 'Standard scenario used: your description could not be applied';
}

// ------------------------------------------------------------------------------------------------ derivation
const roleOfActor = (e: RunEvent): AgentRole | undefined =>
  e.actor.kind === 'agent' ? e.actor.role : undefined;

/** Derive the columns, rows and author banner from the event log. */
export function deriveAgents(events: readonly RunEvent[]): AgentsModel {
  const runs = new Map<string, AgentRunInfo>();
  const rowByKey = new Map<string, AgentRow>();
  const allRows: AgentRow[] = [];
  const byCall = new Map<string, AgentRow>();
  const proposalByApproval = new Map<string, AgentRow>();
  const waitingByApproval = new Map<string, AgentRow>();
  /** Parent agentRunId → role → delegate rows not yet paired with a child's brief. */
  const openDelegations = new Map<string, Map<AgentRole, AgentRow[]>>();
  const pendingFlags = new Map<string, (P<'guardrail.flagged'> & { seq: number })[]>();
  /** Deduplicated/cached calls folded into the row whose result they reused (no row of their own). */
  const merged = new Map<string, AgentRow>();
  const unpush = (row: AgentRow) => {
    const i = allRows.indexOf(row);
    if (i >= 0) allRows.splice(i, 1);
    rowByKey.delete(row.key);
    const runRows = runs.get(row.agentRunId)?.rows;
    const j = runRows?.indexOf(row) ?? -1;
    if (runRows && j >= 0) runRows.splice(j, 1);
  };
  const reuseSource = (
    agentRunId: string,
    tool: string,
    args: unknown,
    from?: string,
  ): AgentRow | undefined => {
    const byId = from ? (merged.get(from) ?? byCall.get(from)) : undefined;
    if (byId) return byId;
    return [...(runs.get(agentRunId)?.rows ?? [])]
      .reverse()
      .find((r) => r.call?.tool === tool && sameArgs(r.call.args, args) && rowByKey.has(r.key));
  };
  const authoring: AuthoringStep[] = [];
  let limits: Partial<RunLimits> | undefined;

  const push = (row: AgentRow) => {
    allRows.push(row);
    rowByKey.set(row.key, row);
    runs.get(row.agentRunId)?.rows.push(row);
  };
  const ensureRun = (id: string, role: AgentRole, seq: number): AgentRunInfo => {
    let r = runs.get(id);
    if (!r) {
      r = { agentRunId: id, role, brief: '', startedSeq: seq, rows: [], childReports: [] };
      runs.set(id, r);
    }
    return r;
  };
  const turnOf = (e: RunEvent) => (typeof e.iteration === 'number' ? e.iteration + 1 : undefined);

  for (const e of events) {
    switch (e.type) {
      case 'run.created':
        limits = e.payload.config?.limits;
        break;
      case 'scenario.authoring':
        authoring.push({
          seq: e.seq,
          minute: e.simMinute,
          status: e.payload.status,
          detail: e.payload.detail,
          ...(e.payload.errors ? { errors: e.payload.errors } : {}),
        });
        break;
      case 'agent.started': {
        if (!e.agentRunId) break;
        const parentId = e.payload.parentAgentRunId ?? e.parentAgentRunId;
        const run = ensureRun(e.agentRunId, e.payload.role, e.seq);
        run.brief = e.payload.brief;
        run.parentAgentRunId = parentId;
        run.startedSeq = e.seq;
        const parent = parentId ? runs.get(parentId) : undefined;
        const row: AgentRow = {
          key: `br-${e.seq}`,
          kind: 'brief',
          seq: e.seq,
          minute: e.simMinute,
          role: e.payload.role,
          agentRunId: e.agentRunId,
          headline: parent
            ? `← brief from ${roleShortName(parent.role)}`
            : e.payload.role === 'orchestrator'
              ? 'Started coordinating the response'
              : 'Started work',
          brief: e.payload.brief,
        };
        // Pair with the parent's delegate call for this role (in call order).
        const queue = parentId ? openDelegations.get(parentId)?.get(e.payload.role) : undefined;
        const out = queue?.shift();
        if (out) {
          out.link = { targetKey: row.key, direction: 'out', role: e.payload.role };
          row.link = { targetKey: out.key, direction: 'in', role: out.role };
        }
        push(row);
        break;
      }
      case 'agent.thought': {
        const role = roleOfActor(e);
        if (!e.agentRunId || !role) break;
        ensureRun(e.agentRunId, role, e.seq);
        push({
          key: `th-${e.seq}`,
          kind: 'thought',
          seq: e.seq,
          minute: e.simMinute,
          role,
          agentRunId: e.agentRunId,
          turn: turnOf(e),
          headline: THOUGHT_HEADLINE,
          thought: { text: e.payload.text, summary: e.payload.summary },
        });
        break;
      }
      case 'agent.tool_call': {
        const role = roleOfActor(e);
        if (!e.agentRunId || !role) break;
        ensureRun(e.agentRunId, role, e.seq);
        const p = e.payload;
        // A deduplicated/cached call (additive marker): a note on the original row, not a new row.
        const marker = p.tool === 'delegate' ? null : reuseMarker(p as unknown as Record<string, unknown>);
        const source = marker ? reuseSource(e.agentRunId, p.tool, p.args, marker.from) : undefined;
        if (source) {
          source.reused = (source.reused ?? 0) + 1;
          merged.set(p.toolCallId, source);
          break;
        }
        const row: AgentRow = {
          key: `tc-${e.seq}`,
          kind: p.tier === 'propose' ? 'proposal' : 'tool',
          seq: e.seq,
          minute: e.simMinute,
          role,
          agentRunId: e.agentRunId,
          turn: turnOf(e),
          headline: headline(p.tool, p.args, undefined, { minute: e.simMinute }),
          tier: p.tier === 'propose' ? 'proposed' : undefined,
          call: { ...p, seq: e.seq },
        };
        byCall.set(p.toolCallId, row);
        if (p.tool === 'delegate') {
          const target = String((p.args as { role?: unknown }).role ?? '') as AgentRole;
          const perParent = openDelegations.get(e.agentRunId) ?? new Map<AgentRole, AgentRow[]>();
          perParent.set(target, [...(perParent.get(target) ?? []), row]);
          openDelegations.set(e.agentRunId, perParent);
        }
        // The report tool is shown by its `agent.report` row; only a refused report gets a row of its own.
        if (p.tool !== 'report') push(row);
        break;
      }
      case 'agent.tool_result': {
        if (merged.has(e.payload.toolCallId)) break;
        const row = byCall.get(e.payload.toolCallId);
        if (!row) break;
        // An idempotent retry answered with an earlier call's result: fold it into that row.
        const from = e.payload.deduplicatedFrom;
        const original = from ? (merged.get(from) ?? byCall.get(from)) : undefined;
        if (original && original !== row && row.kind === 'tool' && rowByKey.has(original.key)) {
          original.reused = (original.reused ?? 0) + 1;
          merged.set(e.payload.toolCallId, original);
          unpush(row);
          break;
        }
        row.result = { ...e.payload, seq: e.seq };
        if (row.kind === 'blocked') break;
        const data = resultData(e.payload.result, e.payload.resultPreview);
        if (!e.payload.ok) {
          row.failed = true;
          // What went wrong, in plain words (never the in-flight "Paged …" wording for a failed call).
          if (row.call)
            row.headline = headline(row.call.tool, row.call.args, data, {
              minute: row.minute,
              failed: true,
              error: e.payload.resultPreview,
            });
          if (isRecordingFailure(e.payload.resultPreview) && row.call)
            row.headline = fitHeadline(`Not recorded (system error): ${toolLabel(row.call.tool)}`);
          if (row.call?.tool === 'report' && !rowByKey.has(row.key)) {
            row.headline = 'Report sent back to the agent to fix';
            push(row);
          }
          break;
        }
        row.headline = headline(row.call!.tool, row.call!.args, data, { minute: row.minute });
        if (row.kind === 'tool') row.tier = 'executed';
        break;
      }
      case 'guardrail.blocked': {
        const p = e.payload;
        const row = p.toolCallId ? byCall.get(p.toolCallId) : undefined;
        const layer = LAYER_LABEL[p.layer] ?? 'blocked';
        if (row) {
          row.kind = 'blocked';
          row.tier = 'blocked';
          row.block = { ...p, seq: e.seq };
          row.headline =
            row.call?.tier === 'forbidden'
              ? headline(row.call.tool, row.call.args)
              : fitHeadline(`Blocked: ${toolLabel(row.call?.tool ?? '')} — ${layer}`);
          if (!rowByKey.has(row.key)) push(row);
          break;
        }
        const role = roleOfActor(e);
        if (!role || !e.agentRunId) break;
        ensureRun(e.agentRunId, role, e.seq);
        push({
          key: `bl-${e.seq}`,
          kind: 'blocked',
          seq: e.seq,
          minute: e.simMinute,
          role,
          agentRunId: e.agentRunId,
          turn: turnOf(e),
          headline: fitHeadline(`Blocked: ${p.tool ? toolLabel(p.tool) : 'an action'} — ${layer}`),
          tier: 'blocked',
          block: { ...p, seq: e.seq },
        });
        break;
      }
      case 'guardrail.flagged': {
        const flag = { ...e.payload, seq: e.seq };
        const row = e.payload.toolCallId ? byCall.get(e.payload.toolCallId) : undefined;
        if (row) row.flags = [...(row.flags ?? []), flag];
        else if (e.agentRunId)
          pendingFlags.set(e.agentRunId, [...(pendingFlags.get(e.agentRunId) ?? []), flag]);
        break;
      }
      case 'agent.proposal': {
        const p = e.payload;
        const row = byCall.get(p.toolCallId);
        const role = row?.role ?? roleOfActor(e);
        const agentRunId = row?.agentRunId ?? e.agentRunId;
        if (!role || !agentRunId) break;
        if (row) {
          row.kind = 'proposal';
          row.tier = 'proposed';
          row.proposal = { ...p, seq: e.seq };
          row.approvalId = p.approvalId;
          proposalByApproval.set(p.approvalId, row);
        }
        const waiting: AgentRow = {
          key: `wt-${e.seq}`,
          kind: 'waiting',
          seq: e.seq,
          minute: e.simMinute,
          role,
          agentRunId,
          turn: turnOf(e) ?? row?.turn,
          headline: waitingHeadline(p.tool),
          proposal: { ...p, seq: e.seq },
          approvalId: p.approvalId,
          pending: true,
        };
        waitingByApproval.set(p.approvalId, waiting);
        push(waiting);
        break;
      }
      case 'approval.decision': {
        const p = e.payload;
        const waiting = waitingByApproval.get(p.approvalId);
        const proposal = proposalByApproval.get(p.approvalId);
        const source = proposal ?? waiting;
        if (waiting) waiting.pending = false;
        const decision = { ...p, seq: e.seq, minute: e.simMinute };
        if (proposal) proposal.decision = decision;
        if (waiting) waiting.decision = decision;
        if (!source) break;
        push({
          key: `dc-${e.seq}`,
          kind: 'decision',
          seq: e.seq,
          minute: e.simMinute,
          role: source.role,
          agentRunId: source.agentRunId,
          headline: decisionHeadline(p, e.simMinute),
          approvalId: p.approvalId,
          decision,
          proposal: source.proposal,
        });
        break;
      }
      case 'approval.invalidated': {
        const p = e.payload;
        const source = proposalByApproval.get(p.approvalId) ?? waitingByApproval.get(p.approvalId);
        const role = source?.role ?? p.role;
        const agentRunId =
          source?.agentRunId ?? [...runs.values()].reverse().find((r) => r.role === role)?.agentRunId;
        if (!role || !agentRunId) break;
        push({
          key: `iv-${e.seq}`,
          kind: 'invalidated',
          seq: e.seq,
          minute: e.simMinute,
          role,
          agentRunId,
          headline: invalidationHeadline(p),
          approvalId: p.approvalId,
          invalidation: p,
          proposal: source?.proposal,
        });
        break;
      }
      case 'agent.report': {
        if (!e.agentRunId) break;
        const run = ensureRun(e.agentRunId, e.payload.role, e.seq);
        const flags = pendingFlags.get(e.agentRunId);
        pendingFlags.delete(e.agentRunId);
        push({
          key: `rp-${e.seq}`,
          kind: 'report',
          seq: e.seq,
          minute: e.simMinute,
          role: e.payload.role,
          agentRunId: e.agentRunId,
          turn: turnOf(e),
          headline: reportHeadline(e.payload.report),
          report: e.payload.report,
          ...(flags?.length ? { flags } : {}),
        });
        const parent = run.parentAgentRunId ? runs.get(run.parentAgentRunId) : undefined;
        parent?.childReports.push({ seq: e.seq, role: e.payload.role, report: e.payload.report });
        break;
      }
      case 'agent.aborted': {
        if (!e.agentRunId) break;
        ensureRun(e.agentRunId, e.payload.role, e.seq);
        push({
          key: `ab-${e.seq}`,
          kind: 'stopped',
          seq: e.seq,
          minute: e.simMinute,
          role: e.payload.role,
          agentRunId: e.agentRunId,
          headline: stopHeadline(e.payload, limits),
          aborted: e.payload,
        });
        break;
      }
      default: {
        // Self-recovery (additive event): the orchestrator picks up again from the record.
        if ((e.type as string) !== 'run.resumed_after_error') break;
        const orch = [...runs.values()].reverse().find((r) => r.role === 'orchestrator');
        const agentRunId = e.agentRunId ?? orch?.agentRunId ?? 'recovery';
        push({
          key: `rc-${e.seq}`,
          kind: 'recovery',
          seq: e.seq,
          minute: e.simMinute,
          role: 'orchestrator',
          agentRunId,
          headline: fitHeadline(RECOVERY_HEADLINE),
        });
        break;
      }
    }
  }
  // Flags that never met a report stay visible on the agent's latest row.
  for (const [id, flags] of pendingFlags) {
    const last = runs.get(id)?.rows.at(-1);
    if (last) last.flags = [...(last.flags ?? []), ...flags];
  }

  for (const run of runs.values()) run.rows.sort((a, b) => a.seq - b.seq || rank(a) - rank(b));

  const columnsByRole = new Map<AgentRole, AgentColumn>();
  const authorRows: AgentRow[] = [];
  for (const row of allRows) {
    if (row.role === 'author') {
      authorRows.push(row);
      continue;
    }
    let col = columnsByRole.get(row.role);
    if (!col) {
      col = { role: row.role, agentRunIds: [], rows: [], firstSeq: row.seq };
      columnsByRole.set(row.role, col);
    }
    if (!col.agentRunIds.includes(row.agentRunId)) col.agentRunIds.push(row.agentRunId);
    col.rows.push(row);
  }
  for (const col of columnsByRole.values()) {
    col.rows.sort((a, b) => a.seq - b.seq || rank(a) - rank(b));
    numberTurns(col, runs);
  }
  const columns = [...columnsByRole.values()]
    .sort((a, b) => a.firstSeq - b.firstSeq || ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role))
    .slice(0, 6);

  const lastStep = authoring.at(-1);
  const author: AuthorBanner | null =
    lastStep || authorRows.length
      ? {
          line: lastStep
            ? authoringLine(lastStep.status, lastStep.detail)
            : 'The Scenario Author prepared the scenario',
          status: lastStep?.status ?? 'patched',
          steps: authoring,
          rows: authorRows,
        }
      : null;

  return { columns, author, rowByKey, runs };
}

/**
 * Continuous turn numbers per column (T1…Tn across re-briefs) and the re-brief divider rows: the brief of the
 * column's 2nd, 3rd… agent run reads "Re-brief 2 from Orchestrator".
 */
function numberTurns(col: AgentColumn, runs: Map<string, AgentRunInfo>): void {
  // Each agent run continues after the previous runs' last turn (a single run keeps its own numbers, which match
  // the Audit view's iteration + 1).
  const offset = new Map<string, number>();
  let total = 0;
  for (const id of col.agentRunIds) {
    offset.set(id, total);
    total += Math.max(0, ...col.rows.filter((r) => r.agentRunId === id).map((r) => r.turn ?? 0));
  }
  for (const r of col.rows) {
    if (r.turn !== undefined) r.columnTurn = (offset.get(r.agentRunId) ?? 0) + r.turn;
    if (r.kind !== 'brief') continue;
    const n = col.agentRunIds.indexOf(r.agentRunId) + 1;
    if (n < 2) continue;
    r.rebrief = n;
    const parentId = runs.get(r.agentRunId)?.parentAgentRunId;
    const parentRole = parentId ? runs.get(parentId)?.role : undefined;
    r.headline = fitHeadline(`Re-brief ${n}${parentRole ? ` from ${roleShortName(parentRole)}` : ''}`);
  }
}

/** Within one seq, a proposal comes before the wait it causes. */
function rank(r: AgentRow): number {
  return r.kind === 'waiting' ? 1 : 0;
}

// ------------------------------------------------------------------------------------------------ status & turns
export function columnStatus(view: RunProjection, role: AgentRole): ColumnStatus | null {
  const agents = Object.values(view.agents).filter((a) => a.role === role);
  if (!agents.length) return null;
  if (agents.some((a) => a.status === 'awaiting_approval')) return 'waiting';
  if (agents.some((a) => a.status === 'running')) return 'working';
  const latest = agents.reduce((a, b) => (b.startedSeq > a.startedSeq ? b : a));
  return latest.status === 'aborted' ? 'blocked' : 'done';
}

/** Distinct turns (agent run × iteration) among the rows up to `uptoSeq`. */
export function turnCount(rows: readonly AgentRow[], uptoSeq = Number.POSITIVE_INFINITY): number {
  const seen = new Set<string>();
  for (const r of rows) if (r.turn !== undefined && r.seq <= uptoSeq) seen.add(`${r.agentRunId}#${r.turn}`);
  return seen.size;
}

/**
 * History mode: per column of the full (live) model, the rows after the cursor — the actions the viewer does not see
 * at that moment ("{n} later actions — Back to live"). Thought rows are not counted when they are hidden.
 */
export function laterActions(
  full: AgentsModel,
  cursorSeq: number,
  opts: { hideThoughts?: boolean } = {},
): Partial<Record<AgentRole, number>> {
  const out: Partial<Record<AgentRole, number>> = {};
  for (const c of full.columns) {
    const n = c.rows.filter((r) => r.seq > cursorSeq && !(opts.hideThoughts && r.kind === 'thought')).length;
    if (n > 0) out[c.role] = n;
  }
  return out;
}

export const STATUS_LABEL: Record<ColumnStatus, string> = {
  working: 'Working',
  waiting: 'Waiting for a decision',
  blocked: 'Blocked',
  done: 'Done',
};

// ------------------------------------------------------------------------------------------------ facts
export interface Fact {
  key: string;
  kind: 'brief' | 'result' | 'report' | 'decision';
  title: string;
  detail?: string;
  failed?: boolean;
  seq: number;
}

function valueText(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (Array.isArray(v))
    return v.every((x) => typeof x !== 'object')
      ? v.join(', ')
      : `${v.length} item${v.length === 1 ? '' : 's'}`;
  if (typeof v === 'object') return `${Object.keys(v).length} fields`;
  return String(v);
}

/** A compact, readable form of a result ("status: unserviceable · stand: 32"), never raw JSON. */
function resultSummary(row: AgentRow): string | undefined {
  const r = row.result;
  if (!r) return undefined;
  const data = r.result && typeof r.result === 'object' ? r.result : undefined;
  let obj: Record<string, unknown> | undefined = data as Record<string, unknown> | undefined;
  if (!obj) {
    try {
      const parsed = JSON.parse(r.resultPreview) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        obj = parsed as Record<string, unknown>;
    } catch {
      /* plain text preview */
    }
  }
  const text = obj
    ? Object.entries(obj)
        .slice(0, 5)
        .map(([k, v]) => `${k}: ${valueText(v)}`)
        .join(' · ')
    : r.resultPreview?.trim();
  return text ? clipText(text, 160) : undefined;
}

/**
 * "Facts gathered by this turn": the agent's brief, the results of its own earlier tool calls up to this turn,
 * the human decisions on its proposals so far and, for an agent that briefed others (the orchestrator), the
 * specialists' reports received so far. Reconstructed from the event log; the model's exact context is in the trace.
 */
export function factsFor(model: AgentsModel, row: AgentRow): Fact[] {
  const run = model.runs.get(row.agentRunId);
  if (!run) return [];
  const facts: Fact[] = [];
  if (run.brief)
    facts.push({
      key: `brief-${run.startedSeq}`,
      kind: 'brief',
      title: 'Brief',
      detail: run.brief,
      seq: run.startedSeq,
    });
  const before = (seq: number) => seq < row.seq;
  for (const r of run.rows) {
    if (r === row || !r.result || !before(r.result.seq)) continue;
    if (row.turn !== undefined && r.turn !== undefined && r.turn >= row.turn) continue;
    if (r.kind === 'blocked') continue;
    facts.push({
      key: `res-${r.key}`,
      kind: 'result',
      title: r.headline,
      detail: resultSummary(r),
      failed: !r.result.ok,
      seq: r.result.seq,
    });
  }
  for (const r of run.rows) {
    if (r.kind !== 'decision' || !before(r.seq)) continue;
    facts.push({ key: `dec-${r.key}`, kind: 'decision', title: r.headline, seq: r.seq });
  }
  for (const c of run.childReports) {
    if (!before(c.seq)) continue;
    facts.push({
      key: `rep-${c.seq}`,
      kind: 'report',
      title: `Report from ${roleShortName(c.role)}`,
      detail: clipText(c.report.summary, 200),
      seq: c.seq,
    });
  }
  return facts.sort((a, b) => a.seq - b.seq);
}

/** The AI reasoning of a row's turn (the thought that preceded it in the same agent run and turn). */
export function reasoningFor(model: AgentsModel, row: AgentRow): string | undefined {
  if (row.thought) return row.thought.text;
  const run = model.runs.get(row.agentRunId);
  if (!run || row.turn === undefined) return undefined;
  let text: string | undefined;
  for (const r of run.rows) {
    if (r.seq > row.seq) break;
    if (r.kind === 'thought' && r.turn === row.turn) text = r.thought?.text;
  }
  return text;
}
