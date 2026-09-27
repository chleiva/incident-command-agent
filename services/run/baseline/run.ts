/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Baseline mode (spec §8, FR-08): no LLM. Walks `scenario.baseline[]` in sim time and executes each action through
 * the SAME tool pipeline and mutation path as the agents, as a named human (`agentRunId: 'baseline'`). Proposals
 * are decided by the `baseline` policy with the chronology's scripted decision. Humans may run forbidden-tier
 * tools (e.g. a certifying engineer's deferral); the mocked systems enforce who may.
 */
import type { Actor, BaselineStep } from '@ica/schema';
import { executeToolCall, type CallSite } from '../runtime/execute';
import type { RunContext } from '../runtime/context';

export const BASELINE_AGENT_RUN_ID = 'baseline';
/** Sim minutes after the last baseline action before the run ends (unless the horizon comes first). */
export const BASELINE_GRACE_MIN = 15;

/** A deterministic UUID-shaped id from the run's seeded rng (the baseline's "client" generates request ids). */
export function seededUuid(rng: () => number): string {
  const hex = Array.from({ length: 32 }, () => Math.floor(rng() * 16).toString(16)).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Scenario baseline steps predate idempotency keys: the human "client" adds a fresh requestId where required. */
export function withRequestId(
  args: Record<string, unknown>,
  idempotencyKey: string | undefined,
  rng: () => number,
): Record<string, unknown> {
  if (idempotencyKey !== '/requestId' || typeof args.requestId === 'string') return args;
  return { ...args, requestId: seededUuid(rng) };
}

export function baselineActor(step: BaselineStep): Actor {
  return { kind: 'human', name: `${step.actor} (baseline)`, roleTitle: step.actor };
}

/** Sleep in world ticks until the sim clock reaches `minute` (or the run ends). */
async function waitForMinute(ctx: RunContext, minute: number): Promise<void> {
  while (!ctx.finished && ctx.sim.simMinute < minute - 1e-9) {
    await ctx.clock.sleep(10_000 / Math.max(1, ctx.sim.speed));
  }
}

/**
 * `skipSteps` (resume): the chronology steps already started before the interruption (one `baseline.action` each)
 * are not repeated; the walk continues with the next one.
 */
export async function runBaseline(ctx: RunContext, opts: { skipSteps?: number } = {}): Promise<void> {
  const steps = [...ctx.scenario.baseline]
    .map((s, i) => ({ s, i }))
    .sort((a, b) => a.s.atMinute - b.s.atMinute || a.i - b.i)
    .map((x) => x.s);
  const byName = new Map(ctx.registry.tools.map((t) => [t.name, t]));
  const skip = Math.max(0, opts.skipSteps ?? 0);
  let n = skip;
  for (const step of steps.slice(skip)) {
    await waitForMinute(ctx, step.atMinute);
    if (ctx.finished) return;
    const actor = baselineActor(step);
    n++;
    await ctx.emit(
      'baseline.action',
      { actor: step.actor, tool: step.action.tool, args: step.action.args, note: step.note },
      actor,
      { agentRunId: BASELINE_AGENT_RUN_ID, iteration: n },
    );
    const site: CallSite = {
      ctx,
      agentRunId: BASELINE_AGENT_RUN_ID,
      role: 'orchestrator',
      agentPath: 'baseline',
      actor,
      iteration: n,
      reasoning: step.note,
      policy: 'baseline',
      human: true,
      scriptedDecision: step.action.decision,
    };
    const tool = byName.get(step.action.tool);
    try {
      await executeToolCall(
        site,
        tool,
        {
          id: `baseline-${n}`,
          name: step.action.tool,
          input: withRequestId(step.action.args, tool?.idempotencyKey, ctx.rng),
        },
        { availableToRole: true },
      );
    } catch (err) {
      ctx.log({
        msg: 'baseline step failed',
        step: n,
        tool: step.action.tool,
        err: String((err as Error).message),
      });
      if (ctx.finished) return;
    }
  }
  const last = steps.at(-1)?.atMinute ?? 0;
  await waitForMinute(ctx, Math.max(last, ctx.sim.simMinute) + BASELINE_GRACE_MIN);
  ctx.finish('report');
}
