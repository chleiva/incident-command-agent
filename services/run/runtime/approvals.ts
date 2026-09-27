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
import type { ApprovalDecisionKind, ApprovalRecord, DecisionOption, Scenario } from '@ica/schema';
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
