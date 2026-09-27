/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Approval policies (RunDeps.approvalsPolicy): `human` waits for an `approval.decision` event written by the API;
 * `baseline` uses the scenario baseline's scripted decision; `eval-auto` approves unless the tool is in the case's
 * `rejectTools` (for `request_decision` it picks the recommended option). Policy decisions are written as
 * `approval.decision` with `decidedBy: {kind:'policy'}`.
 */
import {
  DEFAULT_SIM_AUTO_APPROVE_AFTER_MS,
  SIMULATION_AUTO_ACTOR,
  type ApprovalDecisionKind,
  type ApprovalRecord,
  type DecisionOption,
  type Scenario,
} from '@ica/schema';
import type { Decision, RunContext } from './context';

export type ApprovalPolicy = 'human' | 'baseline' | 'eval-auto';

export interface PolicyDecision {
  decision: ApprovalDecisionKind;
  selectedOptionId?: string;
  reason?: string;
}

export function recommendedOption(args: Record<string, unknown>): string | undefined {
  const options = (args.options as DecisionOption[] | undefined) ?? [];
  const rec = typeof args.recommendedOptionId === 'string' ? args.recommendedOptionId : undefined;
  return rec ?? options.find((o) => o.recommended)?.id ?? options[0]?.id;
}

/** Pure policy decision; `null` for the human policy. */
export function policyDecision(
  policy: ApprovalPolicy,
  tool: string,
  args: Record<string, unknown>,
  opts: { rejectTools?: string[]; scenario?: Scenario; scriptedDecision?: 'approve' | 'reject' } = {},
): PolicyDecision | null {
  if (policy === 'human') return null;
  if (policy === 'eval-auto') {
    if (opts.rejectTools?.includes(tool))
      return { decision: 'reject', reason: 'eval policy: tool listed in rejectTools' };
    if (tool === 'request_decision')
      return { decision: 'approve', selectedOptionId: recommendedOption(args) };
    return { decision: 'approve', reason: 'eval policy: auto-approve' };
  }
  // baseline
  const scripted =
    opts.scriptedDecision ??
    opts.scenario?.baseline.find((s) => s.action.tool === tool)?.action.decision ??
    'approve';
  if (tool === 'request_decision') return { decision: 'approve', selectedOptionId: recommendedOption(args) };
  return scripted === 'reject'
    ? { decision: 'reject', reason: 'baseline chronology: rejected' }
    : { decision: 'approve', reason: 'baseline chronology' };
}

/** Write a policy decision as an `approval.decision` event and update the ApprovalRecord. */
export async function applyPolicyDecision(
  ctx: RunContext,
  record: ApprovalRecord,
  policy: 'baseline' | 'eval-auto',
  d: PolicyDecision,
): Promise<Decision> {
  const decidedBy = { kind: 'policy' as const, policy };
  const e = await ctx.emit(
    'approval.decision',
    {
      approvalId: record.approvalId,
      decision: d.decision,
      ...(d.selectedOptionId ? { selectedOptionId: d.selectedOptionId } : {}),
      ...(d.reason ? { reason: d.reason } : {}),
      decidedBy,
    },
    decidedBy,
  );
  await ctx.deps.store.putApproval({
    ...record,
    status: d.decision === 'approve' ? 'approved' : d.decision === 'edit' ? 'edited' : 'rejected',
    decision: {
      decision: d.decision,
      ...(d.selectedOptionId ? { selectedOptionId: d.selectedOptionId } : {}),
      ...(d.reason ? { reason: d.reason } : {}),
      decidedBy,
      seq: e.seq,
      decidedAt: e.wallTime,
    },
  });
  return {
    decision: d.decision,
    selectedOptionId: d.selectedOptionId,
    reason: d.reason,
    decidedBy,
    seq: e.seq,
  };
}

/** The `human` policy's safety-net delay (real time): `RunDeps.simAutoApproveAfterMs`, else 120 s; 0 = off. */
export function simAutoApproveAfterMs(ctx: Pick<RunContext, 'deps'>): number {
  return ctx.deps.simAutoApproveAfterMs ?? DEFAULT_SIM_AUTO_APPROVE_AFTER_MS;
}

/**
 * Simulation safety net: approve a still-pending approval as `{kind:'policy', policy:'simulation-auto'}` so an
 * unattended run does not stall. It claims the ApprovalRecord conditionally first (pending → approved), exactly like
 * the API, so it can never double-decide with the browser: returns false when someone else decided first. A
 * decision with options takes the recommended option. Writes the normal `approval.decision` event.
 */
/** Decisions reserved for certifying staff: the simulation never approves these (it closes them as not decided). */
export const CERTIFYING_TOOLS: ReadonlySet<string> = new Set(['record_engineering_decision']);

export async function applySimulationAutoApproval(ctx: RunContext, record: ApprovalRecord): Promise<boolean> {
  const { store } = ctx.deps;
  if (CERTIFYING_TOOLS.has(record.tool)) return closeCertifyingAsNotDecided(ctx, record);
  if (!(await store.decideApproval(ctx.runId, record.approvalId, 'pending', { status: 'approved' })))
    return false;
  const selectedOptionId = record.options?.length
    ? (record.options.find((o) => o.recommended)?.id ??
      recommendedOption(record.args) ??
      record.options[0]!.id)
    : undefined;
  const decidedBy = SIMULATION_AUTO_ACTOR;
  let e;
  try {
    e = await ctx.emit(
      'approval.decision',
      {
        approvalId: record.approvalId,
        decision: 'approve',
        ...(selectedOptionId ? { selectedOptionId } : {}),
        decidedBy,
      },
      decidedBy,
    );
  } catch (err) {
    await store
      .decideApproval(ctx.runId, record.approvalId, 'approved', { status: 'pending', decision: undefined })
      .catch(() => undefined);
    throw err;
  }
  await store.decideApproval(ctx.runId, record.approvalId, 'approved', {
    decision: {
      decision: 'approve',
      ...(selectedOptionId ? { selectedOptionId } : {}),
      decidedBy,
      seq: e.seq,
      decidedAt: e.wallTime,
    },
  });
  return true;
}

/**
 * The safety net for an airworthiness decision: nobody from certifying staff decided in time, so it is closed as
 * NOT decided (a reject with an explicit reason) rather than approved. The agent continues with airworthiness
 * undetermined; nothing is recorded as a certifying decision.
 */
async function closeCertifyingAsNotDecided(ctx: RunContext, record: ApprovalRecord): Promise<boolean> {
  const { store } = ctx.deps;
  if (!(await store.decideApproval(ctx.runId, record.approvalId, 'pending', { status: 'rejected' })))
    return false;
  const decidedBy = SIMULATION_AUTO_ACTOR;
  const reason =
    'Not decided: reserved for certifying staff and nobody decided in time (simulation). Treat airworthiness as undetermined.';
  let e;
  try {
    e = await ctx.emit(
      'approval.decision',
      { approvalId: record.approvalId, decision: 'reject', reason, decidedBy },
      decidedBy,
    );
  } catch (err) {
    await store
      .decideApproval(ctx.runId, record.approvalId, 'rejected', { status: 'pending', decision: undefined })
      .catch(() => undefined);
    throw err;
  }
  await store.decideApproval(ctx.runId, record.approvalId, 'rejected', {
    decision: { decision: 'reject', reason, decidedBy, seq: e.seq, decidedAt: e.wallTime },
  });
  return true;
}
