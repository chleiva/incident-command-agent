/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Presenter-driven runtime actions (agent mode only):
 * - `demonstrateForbidden`: the "Demonstrate blocked action" control (`control.requested{demo_forbidden}`) pushes a
 *   synthetic forbidden call THROUGH THE REAL TIER GATE (`executeToolCall`), attributed to the maintenance agent and
 *   flagged `presenterTriggered: true`. It produces exactly the same `guardrail.blocked` event and safety-gate count
 *   as a real attempt; nothing in the UI fakes it.
 * - `reviseAfterInvalidation`: after `approval.invalidated`, the owning agent re-gathers evidence and issues a
 *   revised proposal linked by `supersedesApprovalId`.
 */
import type { Actor, DemoForbiddenTool, RunEvent } from '@ica/schema';
import { runAgent } from './agent';
import { AgentAbort, type RunContext } from './context';
import { executeToolCall, type CallSite } from './execute';
import { revisionBrief, type Invalidation } from './invalidation';

/** Plausible arguments for the demonstrated call (the tier gate refuses it before any argument matters). */
export function demoArgs(ctx: RunContext, tool: DemoForbiddenTool): Record<string, unknown> {
  const tail = ctx.scenario.aircraft.tail;
  if (tool === 'release_aircraft') return { tail };
  if (tool === 'extend_crew_fdp') {
    const crew =
      Object.values(ctx.state.crew?.crew ?? {}).find((c) => c.status === 'operating') ??
      Object.values(ctx.state.crew?.crew ?? {})[0];
    return { crewId: crew?.id ?? 'crew-1', minutes: 60 };
  }
  const defect =
    Object.values(ctx.state.mne?.defects ?? {}).find((d) => d.tail === tail && d.status === 'open') ??
    Object.values(ctx.state.mne?.defects ?? {})[0];
  return { defectId: defect?.id ?? 'DEF-001', melItem: defect?.melItem ?? '00-00-00' };
}

export async function demonstrateForbidden(ctx: RunContext, tool: DemoForbiddenTool): Promise<void> {
  const def = ctx.registry.tools.find((t) => t.name === tool);
  if (!def || def.tier !== 'forbidden') {
    ctx.log({ msg: 'demo_forbidden: not a forbidden tool', tool });
    return;
  }
  const role = 'maintenance' as const;
  const started = [...ctx.eventLog()]
    .reverse()
    .find((e): e is RunEvent<'agent.started'> => e.type === 'agent.started' && e.payload.role === role);
  const actor: Actor = { kind: 'agent', role };
  const site: CallSite = {
    ctx,
    agentRunId: started?.agentRunId ?? 'presenter-demo',
    ...(started?.parentAgentRunId ? { parentAgentRunId: started.parentAgentRunId } : {}),
    role,
    agentPath: 'presenter-demo',
    actor,
    iteration: 0,
    reasoning: 'Presenter demonstration of the autonomy policy.',
    policy: 'human',
    presenterTriggered: true,
  };
  try {
    await executeToolCall(
      site,
      def,
      { id: ctx.ids.next('tc-demo'), name: tool, input: demoArgs(ctx, tool) },
      { availableToRole: true },
    );
  } catch (err) {
    if (!(err instanceof AgentAbort)) throw err;
    ctx.log({ msg: 'demo_forbidden refused by run limits', detail: err.detail });
  }
}

/** Re-run the owning agent to re-gather evidence and issue a revised proposal (orchestrator-owned: notice only). */
export async function reviseAfterInvalidation(ctx: RunContext, inv: Invalidation): Promise<void> {
  if (!inv.role || ctx.stopping) return;
  if (inv.role === 'orchestrator') {
    // The orchestrator is the coordinator: it sees the change as data on its next turn and re-delegates itself.
    ctx.twistFeed.push({
      seq: 0,
      title: 'Approval invalidated',
      text: revisionBrief(inv),
    });
    return;
  }
  const orchestrator = ctx
    .eventLog()
    .find(
      (e): e is RunEvent<'agent.started'> => e.type === 'agent.started' && e.payload.role === 'orchestrator',
    );
  const n = ctx.ids.next('revision').split('-').at(-1);
  await runAgent(inv.role, revisionBrief(inv), ctx, {
    ...(orchestrator?.agentRunId ? { parentAgentRunId: orchestrator.agentRunId } : {}),
    agentPath: `revise/${inv.role}.${n}`,
    supersedesApprovalId: inv.approvalId,
  });
}
