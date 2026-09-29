/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * The tool-call pipeline shared by agents and the baseline: arg validation → ref validation → tier (forbidden →
 * blocked; propose → proposal + approval, blocking this caller only; execute) → output screening → handler →
 * mutations + `agent.tool_result` in ONE `store.append` (spec §5).
 */
import type {
  Actor,
  AgentRole,
  ApprovalRecord,
  ApprovalScope,
  Citation,
  DecisionOption,
  EventPayloadMap,
  EventDraft,
  PriorToolCall,
  RunEvent,
  SystemMutation,
  ToolContext,
  ToolDefinition,
  ToolOutcome,
} from '@ica/schema';
import { getPointer, screenOutput, textAtPointers } from '../guardrails/screen-output';
import { lenientArgs, validateRefs, validateToolArgs } from '../guardrails/validate';
import { wrapToolResult } from '../guardrails/wrap';
import {
  applyPolicyDecision,
  applySimulationAutoApproval,
  policyDecision,
  simAutoApproveAfterMs,
  type ApprovalPolicy,
} from './approvals';
import { AgentAbort, type Decision, type RunContext } from './context';
import { netMutations } from '../systems/util';
import { deriveAssumptions } from './invalidation';
import { forbiddenExplanation, forbiddenRule, isRuntimeTool, type RuntimeSite } from './tools';
import { deepClone, preview } from './util';

export interface CallSite {
  ctx: RunContext;
  agentRunId: string;
  parentAgentRunId?: string;
  role: AgentRole;
  agentPath: string;
  /** Actor on the events (the agent, or the baseline human). */
  actor: Actor;
  iteration: number;
  /** The model's text for this turn (becomes the proposal's reasoning). */
  reasoning: string;
  policy: ApprovalPolicy;
  /** Baseline: humans may execute forbidden-tier tools (the systems enforce who may). */
  human?: boolean;
  /** Baseline: the chronology's scripted decision for proposals. */
  scriptedDecision?: 'approve' | 'reject';
  runtime?: RuntimeSite;
  /** A synthetic call pushed by the presenter's "Demonstrate blocked action" control (task 06 §1.3). */
  presenterTriggered?: boolean;
  /** Revision after `approval.invalidated`: the first proposal of this agent supersedes that approval. */
  revision?: { approvalId: string; used: boolean };
}

export interface ToolCallInput {
  id: string;
  name: string;
  input: Record<string, unknown>;
  /** The loop normalised a role-named call (`ground{brief}`) to `delegate` (see call-repair.ts). */
  normalisedFrom?: string;
  /** Argument keys recovered from leaked tool-call markup (see call-repair.ts). */
  argsRepaired?: string[];
  /** Free-text fields truncated at their schema cap (length leniency, live run 2). */
  argsTruncated?: string[];
  /** Over-cap free-text fields passed through uncut because the tool splits them (`splitOverlong`). */
  argsSplit?: string[];
}

export interface ToolCallResult {
  ok: boolean;
  /** Wrapped `<tool_result>` text for the model. */
  content: string;
  isError: boolean;
  data?: unknown;
  blocked?: 'tier' | 'arg_validation' | 'ref_validation' | 'output_screen';
}

function envExtra(site: CallSite) {
  return {
    agentRunId: site.agentRunId,
    ...(site.parentAgentRunId ? { parentAgentRunId: site.parentAgentRunId } : {}),
    iteration: site.iteration,
  };
}

function wrapped(tool: string, system: string, body: unknown): string {
  return wrapToolResult(`${system}:${tool}`, typeof body === 'string' ? body : JSON.stringify(body));
}

async function block(
  site: CallSite,
  call: ToolCallInput,
  layer: 'tier' | 'arg_validation' | 'ref_validation' | 'output_screen',
  reason: string,
  message: string,
  excerpt?: string,
  system = 'runtime',
): Promise<ToolCallResult> {
  const { ctx } = site;
  await ctx.append([
    ctx.draft(
      'guardrail.blocked',
      {
        layer,
        tool: call.name,
        reason: reason.slice(0, 1000),
        toolCallId: call.id,
        ...(excerpt ? { excerpt: excerpt.slice(0, 200) } : {}),
        ...(layer === 'tier' ? forbiddenRule(call.name) : {}),
        ...(site.presenterTriggered ? { presenterTriggered: true } : {}),
      },
      site.actor,
      envExtra(site),
    ),
    ctx.draft(
      'agent.tool_result',
      { toolCallId: call.id, tool: call.name, ok: false, resultPreview: preview(message) },
      site.actor,
      envExtra(site),
    ),
  ]);
  return {
    ok: false,
    isError: true,
    content: wrapped(call.name, system, { error: message }),
    blocked: layer,
  };
}

/** Validate args + refs (+ output screen). Returns an error result or null when the call may proceed. */
async function checkCall(
  site: CallSite,
  tool: ToolDefinition,
  call: ToolCallInput,
  args: Record<string, unknown>,
): Promise<ToolCallResult | null> {
  // Fields the tool splits itself are validated at their cap (everything else about them still applies).
  let checked = args;
  if (call.argsSplit?.length) {
    checked = deepClone(args);
    for (const p of call.argsSplit) {
      const key = p.replace(/^\//, '');
      const cap = (tool.inputSchema as { properties?: Record<string, { maxLength?: number }> }).properties?.[
        key
      ]?.maxLength;
      if (typeof checked[key] === 'string' && cap) checked[key] = (checked[key] as string).slice(0, cap);
    }
  }
  const v = validateToolArgs(tool, checked);
  if (!v.ok) {
    return block(
      site,
      call,
      'arg_validation',
      `invalid arguments: ${v.errors.join('; ')}`,
      `Invalid arguments for ${tool.name}: ${v.errors.join('; ')}. Fix them and call again.`,
      undefined,
      tool.system,
    );
  }
  const r = validateRefs(tool, args, site.ctx.knownRefs());
  if (!r.ok) {
    return block(
      site,
      call,
      'ref_validation',
      `unknown references: ${r.errors.join('; ')}`,
      `Unknown identifiers for ${tool.name}: ${r.errors.join('; ')}. Use ids that exist in this run (read them with the system tools first).`,
      undefined,
      tool.system,
    );
  }
  if (tool.outputScreen) {
    const texts = textAtPointers(args, tool.outputScreen.fields);
    const findings = texts.flatMap((t) => screenOutput(tool.outputScreen!.kind, t).findings);
    if (findings.length) {
      return block(
        site,
        call,
        'output_screen',
        `output screening (${tool.outputScreen.kind}): ${findings.map((f) => f.pattern).join(', ')}`,
        `The draft was blocked by output screening (${findings
          .map((f) => f.pattern)
          .join(
            ', ',
          )}). Redraft it without these elements (no legal claims such as "extraordinary circumstances" or compensation denials, no URLs outside the allow-list, no personal data, no secrets) and call again.`,
        findings[0].excerpt,
        tool.system,
      );
    }
  }
  return null;
}

/** This agent run's earlier calls of `tool` (oldest first), excluding `currentId`, with their outcomes. */
function priorCallsOf(site: CallSite, tool: string, currentId: string): PriorToolCall[] {
  const events = site.ctx.eventLog();
  const results = new Map<string, RunEvent<'agent.tool_result'>['payload']>();
  for (const e of events)
    if (e.type === 'agent.tool_result' && e.agentRunId === site.agentRunId)
      results.set(e.payload.toolCallId, e.payload);
  const out: PriorToolCall[] = [];
  for (const e of events) {
    if (e.type !== 'agent.tool_call' || e.agentRunId !== site.agentRunId) continue;
    if (e.payload.tool !== tool || e.payload.toolCallId === currentId) continue;
    const r = results.get(e.payload.toolCallId);
    if (!r) continue;
    out.push({
      toolCallId: e.payload.toolCallId,
      args: (e.payload.args ?? {}) as Record<string, unknown>,
      ok: r.ok,
      atMinute: e.simMinute,
      ...(r.result !== undefined ? { result: r.result } : {}),
    });
  }
  return out;
}

/** Run the handler and persist its mutations together with the tool result. */
async function runHandler(
  site: CallSite,
  tool: ToolDefinition,
  call: ToolCallInput,
  args: Record<string, unknown>,
  callSeq: number,
  decision?: Decision,
  approvedBy?: Actor,
): Promise<ToolCallResult> {
  const { ctx } = site;
  let outcome: ToolOutcome;
  try {
    if (isRuntimeTool(tool)) {
      if (!site.runtime) throw new Error(`runtime tool ${tool.name} is not available here`);
      outcome = await tool.run(args, site.runtime, { decision });
    } else {
      const toolCtx: ToolContext = {
        runId: ctx.runId,
        agentRunId: site.agentRunId,
        role: site.role,
        actor: site.actor,
        ...(approvedBy ? { approvedBy } : {}),
        ...(approvedBy?.kind === 'human' && decision?.method === 'implicit'
          ? { approvalMethod: 'implicit' as const }
          : {}),
        ...(ctx.latestKpis ? { kpis: deepClone(ctx.latestKpis) } : {}),
        simMinute: ctx.sim.simMinute,
        state: deepClone(ctx.state),
        scenario: ctx.scenario,
        knowledge: ctx.knowledge,
        rng: ctx.rng,
        log: (msg) => ctx.log({ agentRunId: site.agentRunId, tool: tool.name, msg }),
        priorCalls: (name) => priorCallsOf(site, name, call.id),
      };
      outcome = await tool.handler(args, toolCtx);
    }
  } catch (err) {
    if (err instanceof AgentAbort) throw err;
    outcome = { ok: false, error: `tool failed: ${(err as Error).message}` };
  }
  if (!outcome.ok) {
    // A failure may carry structured detail (e.g. page_engineer's alternatives): recorded and sent to the model.
    const detail =
      outcome.data && typeof outcome.data === 'object' && !Array.isArray(outcome.data)
        ? (outcome.data as Record<string, unknown>)
        : undefined;
    await ctx.append([
      ctx.draft(
        'agent.tool_result',
        {
          toolCallId: call.id,
          tool: tool.name,
          ok: false,
          resultPreview: preview(outcome.error),
          ...(detail ? { result: detail } : {}),
        },
        site.actor,
        envExtra(site),
      ),
    ]);
    return {
      ok: false,
      isError: true,
      content: wrapped(tool.name, tool.system, { error: outcome.error, ...(detail ?? {}) }),
      ...(detail ? { data: detail } : {}),
    };
  }
  // One net mutation per row: a handler that chains helpers may touch a row twice (one transaction cannot).
  const mutations: SystemMutation[] = netMutations(outcome.mutations ?? []);
  const citations: Citation[] | undefined = outcome.citations?.length ? outcome.citations : undefined;
  const drafts: EventDraft[] = [
    // A proposal approved by a person changes state on that person's authority: its mutations carry the approving
    // human as actor (agentRunId still links the agent). Everything else is attributed to the caller.
    ...ctx.mutationDrafts(
      mutations,
      approvedBy?.kind === 'human' ? approvedBy : site.actor,
      envExtra(site),
      callSeq,
    ),
    ctx.draft(
      'agent.tool_result',
      {
        toolCallId: call.id,
        tool: tool.name,
        ok: true,
        resultPreview: preview(outcome.data),
        result: outcome.data,
        ...(citations ? { citations } : {}),
      },
      site.actor,
      envExtra(site),
    ),
  ];
  await ctx.append(drafts, mutations);
  for (const f of outcome.followUps ?? []) ctx.scheduleFollowUp(f);
  const body = citations ? { data: outcome.data, citations } : outcome.data;
  return {
    ok: true,
    isError: false,
    content: wrapped(tool.name, tool.system, body ?? { ok: true }),
    data: outcome.data,
  };
}

/** Canonical JSON of tool args (keys sorted, recursively): the identity of a call for dedupe and caching. */
export function canonicalArgs(value: unknown): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === 'object')
      return Object.fromEntries(
        Object.keys(v as Record<string, unknown>)
          .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
          .sort()
          .map((k) => [k, norm((v as Record<string, unknown>)[k])]),
      );
    return v;
  };
  return JSON.stringify(norm(value ?? {}));
}

/**
 * Answer a call with an earlier call's outcome without running anything: an identical call in the same model turn
 * (`deduplicated`) or a read-only cache hit (`cached`). Both events are written (visible in the timeline and the
 * audit) with the original call's id; nothing is counted against the tool caps.
 */
export async function replayToolCall(
  site: CallSite,
  tool: ToolDefinition,
  call: ToolCallInput,
  source: { toolCallId: string; result: ToolCallResult },
  kind: 'deduplicated' | 'cached',
): Promise<ToolCallResult> {
  const { ctx } = site;
  const marker =
    kind === 'deduplicated' ? { deduplicatedFrom: source.toolCallId } : { cachedFrom: source.toolCallId };
  const prior = ctx
    .eventLog()
    .findLast(
      (e): e is RunEvent<'agent.tool_result'> =>
        e.type === 'agent.tool_result' && e.payload.toolCallId === source.toolCallId,
    );
  const {
    deduplicatedFrom: _d,
    cachedFrom: _c,
    ...priorPayload
  } = prior?.payload ?? {
    tool: tool.name,
    ok: source.result.ok,
    resultPreview: preview(source.result.data ?? source.result.content),
  };
  await ctx.append([
    ctx.draft(
      'agent.tool_call',
      {
        toolCallId: call.id,
        tool: tool.name,
        system: tool.system,
        tier: tool.tier,
        args: (call.input ?? {}) as Record<string, unknown>,
        ...marker,
      },
      site.actor,
      envExtra(site),
    ),
    ctx.draft(
      'agent.tool_result',
      { ...priorPayload, toolCallId: call.id, tool: tool.name, ...marker },
      site.actor,
      envExtra(site),
    ),
  ]);
  return source.result;
}

/**
 * Resume: re-attach an approval that was still pending when the previous invocation stopped. Its proposing agent
 * is gone, so this waits for the decision on its own and then runs the tool exactly as the agent would have
 * (approve/edit → the handler with the approver; reject → a rejected result). Nothing is re-proposed.
 */
export async function reattachApproval(
  ctx: RunContext,
  record: ApprovalRecord,
  tool: ToolDefinition | undefined,
  policy: ApprovalPolicy,
): Promise<void> {
  const call = ctx
    .eventLog()
    .find(
      (e): e is RunEvent<'agent.tool_call'> =>
        e.type === 'agent.tool_call' && e.payload.toolCallId === record.toolCallId,
    );
  const role = record.role;
  const site: CallSite = {
    ctx,
    agentRunId: record.agentRunId,
    role,
    agentPath: `${role}/reattached`,
    actor: call?.actor ?? { kind: 'agent', role },
    iteration: call?.iteration ?? 0,
    reasoning: record.reasoning ?? '',
    policy,
  };
  const auto =
    policy === 'human'
      ? null
      : policyDecision(policy, record.tool, record.args, {
          rejectTools: ctx.rejectTools,
          scenario: ctx.scenario,
        });
  const afterMs = policy === 'human' ? simAutoApproveAfterMs(ctx) : 0;
  const decision =
    auto && policy !== 'human'
      ? await applyPolicyDecision(ctx, record, policy, auto)
      : await ctx.waitForDecision(
          record.approvalId,
          afterMs > 0 ? { afterMs, approve: () => applySimulationAutoApproval(ctx, record) } : undefined,
        );
  const input: ToolCallInput = { id: record.toolCallId, name: record.tool, input: record.args };
  if (decision.decision === 'reject' || !tool || isRuntimeTool(tool)) {
    const msg =
      decision.decision === 'reject'
        ? `rejected: ${decision.reason ?? 'no reason given'}`
        : `${decision.decision}d (recorded; ${record.tool} is not re-run after a resume)`;
    await ctx.append([
      ctx.draft(
        'agent.tool_result',
        {
          toolCallId: record.toolCallId,
          tool: record.tool,
          ok: decision.decision !== 'reject',
          resultPreview: preview(msg),
        },
        site.actor,
        envExtra(site),
      ),
    ]);
    return;
  }
  const args =
    decision.decision === 'edit'
      ? ((decision.editedArgs ?? record.args) as Record<string, unknown>)
      : record.args;
  if (decision.decision === 'edit' && (await checkCall(site, tool, input, args))) return;
  await runHandler(site, tool, input, args, call?.seq ?? 0, decision, decision.decidedBy).catch((err) =>
    containToolFailure(site, tool, input, err),
  );
}

const DEFAULT_EXCLUSIONS = [
  'Any other action: each needs its own approval',
  'Any human-only decision (deferral, release, FDP extension, departure)',
];
const NO_CHECKS_STATED = 'Not stated by the agent: verify the evidence before approving';

/** Default approval scope of a propose-tier tool (task 06 §1.5): from the tool definition. */
export function approvalScopeOf(tool: ToolDefinition): ApprovalScope {
  return {
    authorises: tool.approvalScope ?? `Running ${tool.name} once with the arguments shown.`,
    doesNotAuthorise: tool.approvalExclusions ?? DEFAULT_EXCLUSIONS,
  };
}

/** Provenance of a proposal: sources this agent read, data as-of minute, unresolved checks, scope. */
function proposalProvenance(
  site: CallSite,
  tool: ToolDefinition,
  agentChecks: string[] | undefined,
): Pick<
  EventPayloadMap['agent.proposal'],
  'unresolvedChecks' | 'approvalScope' | 'citations' | 'dataAsOfMinute'
> {
  const own = site.ctx
    .eventLog()
    .filter(
      (e): e is RunEvent<'agent.tool_result'> =>
        e.type === 'agent.tool_result' && e.agentRunId === site.agentRunId && e.payload.ok,
    );
  const seen = new Set<string>();
  const citations: Citation[] = [];
  for (const e of [...own].reverse()) {
    for (const c of e.payload.citations ?? []) {
      if (seen.has(c.chunkId) || citations.length >= 5) continue;
      seen.add(c.chunkId);
      citations.push(c);
    }
  }
  const asOf = own.length ? Math.max(...own.map((e) => e.simMinute)) : site.ctx.sim.simMinute;
  const checks = agentChecks?.length
    ? agentChecks
    : tool.defaultUnresolvedChecks?.length
      ? tool.defaultUnresolvedChecks
      : [NO_CHECKS_STATED];
  return {
    unresolvedChecks: checks.slice(0, 12).map((c) => c.slice(0, 300)),
    approvalScope: approvalScopeOf(tool),
    ...(citations.length ? { citations } : {}),
    dataAsOfMinute: Math.round(asOf * 100) / 100,
  };
}

/** request_decision options: each gets the data as-of minute and a default scope (the agent's values win). */
function withOptionProvenance(options: DecisionOption[], asOf: number | undefined): DecisionOption[] {
  return options.map((o) => ({
    ...o,
    // Always a boolean on the event (the tool schema lets the model omit it; the loop derives it).
    recommended: o.recommended === true,
    metrics: {
      ...o.metrics,
      constraints: Array.isArray(o.metrics?.constraints) ? o.metrics.constraints : [],
    },
    ...(o.dataAsOfMinute === undefined && asOf !== undefined ? { dataAsOfMinute: asOf } : {}),
    approvalScope: o.approvalScope ?? {
      authorises: `Choosing “${o.label}” as the plan. Each action it leads to is proposed and approved separately.`,
      doesNotAuthorise: DEFAULT_EXCLUSIONS,
    },
  }));
}

/**
 * Idempotency (task 06 §1.9): an earlier call of the same tool with the same key. `done` = it succeeded (its result
 * is returned again); `pending` = it is still waiting for a human decision.
 */
function priorIdempotentCall(
  site: CallSite,
  tool: ToolDefinition,
  key: unknown,
  callId: string,
):
  | { kind: 'done'; toolCallId: string; result: RunEvent<'agent.tool_result'>['payload'] }
  | { kind: 'pending'; toolCallId: string; approvalId: string }
  | null {
  if (key === undefined || key === null || key === '' || !tool.idempotencyKey) return null;
  const events = site.ctx.eventLog();
  const calls = events.filter(
    (e): e is RunEvent<'agent.tool_call'> =>
      e.type === 'agent.tool_call' &&
      e.payload.tool === tool.name &&
      e.payload.toolCallId !== callId &&
      getPointer(e.payload.args, tool.idempotencyKey!) === key,
  );
  for (const c of calls) {
    const id = c.payload.toolCallId;
    const res = events.find(
      (e): e is RunEvent<'agent.tool_result'> =>
        e.type === 'agent.tool_result' && e.payload.toolCallId === id && e.payload.ok,
    );
    if (res) return { kind: 'done', toolCallId: id, result: res.payload };
  }
  for (const c of calls) {
    const id = c.payload.toolCallId;
    const answered = events.some((e) => e.type === 'agent.tool_result' && e.payload.toolCallId === id);
    const proposal = events.find(
      (e): e is RunEvent<'agent.proposal'> => e.type === 'agent.proposal' && e.payload.toolCallId === id,
    );
    if (proposal && !answered)
      return { kind: 'pending', toolCallId: id, approvalId: proposal.payload.approvalId };
  }
  return null;
}

function proposalSummary(tool: string, args: Record<string, unknown>): string {
  if (tool === 'request_decision' && typeof args.question === 'string') return args.question.slice(0, 300);
  return `${tool} ${preview(args, 240)}`;
}

/**
 * The full pipeline for one tool call. `tool` is undefined for unknown tool names.
 *
 * Length leniency (live run 2): when the only validation errors are `maxLength` on free-text fields, the call is
 * accepted with those values truncated at the cap (recorded as `argsTruncated` on `agent.tool_call`, and the model
 * is told in the tool result) instead of wasting a tool call on a retry. Fields the tool splits itself
 * (`splitOverlong`, e.g. `append_timeline` `/text`) pass through uncut. Every other validation still rejects.
 */
export async function executeToolCall(
  site: CallSite,
  tool: ToolDefinition | undefined,
  call: ToolCallInput,
  opts: { availableToRole: boolean },
): Promise<ToolCallResult> {
  try {
    return await executeToolCallLenient(site, tool, call, opts);
  } catch (err) {
    if (err instanceof AgentAbort) throw err;
    return containToolFailure(site, tool, call, err);
  }
}

/** What the agent is told when its call could not be recorded (self-recovery: the agent decides what next). */
export const TOOL_FAILURE_MESSAGE =
  'The system could not record this action; nothing was changed. Try again or continue.';

/**
 * Contain an unexpected failure of one tool call (a store write that failed after retries, a bug in a handler's
 * persistence path): the call becomes an error result for the agent, never a failed run. The mutations and the
 * tool result travel in ONE transaction, so a failed write changed nothing. A `system.error` (+ the tool result) is
 * written best-effort so the failure is visible; when even that fails, the event log's own failure counter decides
 * whether the run must stop.
 */
async function containToolFailure(
  site: CallSite,
  tool: ToolDefinition | undefined,
  call: ToolCallInput,
  err: unknown,
): Promise<ToolCallResult> {
  const { ctx } = site;
  const detail = String((err as Error)?.message ?? err).slice(0, 300);
  ctx.log({ msg: 'tool call contained', agentRunId: site.agentRunId, tool: call.name, err: detail });
  await ctx
    .append([
      ctx.draft(
        'system.error',
        {
          scope: 'tool',
          message: `${call.name}: ${detail}`.slice(0, 1000),
          tool: call.name,
          toolCallId: call.id,
          ...(site.actor.kind === 'agent' ? { role: site.actor.role } : {}),
        },
        site.actor,
        envExtra(site),
      ),
      ctx.draft(
        'agent.tool_result',
        { toolCallId: call.id, tool: call.name, ok: false, resultPreview: TOOL_FAILURE_MESSAGE },
        site.actor,
        envExtra(site),
      ),
    ])
    .catch(() => undefined);
  return {
    ok: false,
    isError: true,
    content: wrapped(call.name, tool?.system ?? 'runtime', { error: TOOL_FAILURE_MESSAGE }),
  };
}

async function executeToolCallLenient(
  site: CallSite,
  tool: ToolDefinition | undefined,
  call: ToolCallInput,
  opts: { availableToRole: boolean },
): Promise<ToolCallResult> {
  if (!tool) return executeToolCallCore(site, tool, call, opts);
  const input = (call.input ?? {}) as Record<string, unknown>;
  const lifts = tool.tier === 'propose' && tool.name !== 'request_decision' && 'unresolvedChecks' in input;
  const { unresolvedChecks, ...rest } = input;
  const len = lenientArgs(tool, lifts ? rest : input);
  if (!len || (!len.truncated.length && !len.split.length))
    return executeToolCallCore(site, tool, call, opts);
  const res = await executeToolCallCore(
    site,
    tool,
    {
      ...call,
      input: lifts ? { ...len.args, unresolvedChecks } : len.args,
      ...(len.truncated.length ? { argsTruncated: len.truncated } : {}),
      ...(len.split.length ? { argsSplit: len.split } : {}),
    },
    opts,
  );
  if (!len.truncated.length) return res;
  const note = `Accepted with ${len.truncated.join(', ')} truncated at the length cap (marked "…[truncated]"). Keep these fields shorter next time.`;
  return { ...res, content: `${res.content}\n${wrapToolResult('runtime:args', JSON.stringify({ note }))}` };
}

async function executeToolCallCore(
  site: CallSite,
  tool: ToolDefinition | undefined,
  call: ToolCallInput,
  opts: { availableToRole: boolean },
): Promise<ToolCallResult> {
  const { ctx } = site;
  ctx.countToolCall(site.agentRunId);
  if (!tool) {
    await ctx.append([
      ctx.draft(
        'guardrail.blocked',
        {
          layer: 'arg_validation',
          tool: call.name,
          reason: `unknown tool '${call.name}'`,
          toolCallId: call.id,
        },
        site.actor,
        envExtra(site),
      ),
    ]);
    return {
      ok: false,
      isError: true,
      content: wrapped(call.name, 'runtime', {
        error: `Unknown tool '${call.name}'. Use only the tools you were given.`,
      }),
      blocked: 'arg_validation',
    };
  }
  let args = (call.input ?? {}) as Record<string, unknown>;
  // Propose tier: the agent may state what is still unverified (`unresolvedChecks`, shown on the decision card).
  // Domain tools do not take it as an argument, so it is lifted off the args before validation.
  let agentChecks: string[] | undefined;
  if (tool.tier === 'propose' && Array.isArray(args.unresolvedChecks)) {
    agentChecks = args.unresolvedChecks.filter((x): x is string => typeof x === 'string');
    if (tool.name !== 'request_decision') {
      const { unresolvedChecks: _lifted, ...rest } = args;
      args = rest;
    }
  }
  const [callEvent] = await ctx.append([
    ctx.draft(
      'agent.tool_call',
      {
        toolCallId: call.id,
        tool: tool.name,
        system: tool.system,
        tier: tool.tier,
        args,
        ...(site.presenterTriggered ? { presenterTriggered: true } : {}),
        ...(call.normalisedFrom ? { normalisedFrom: call.normalisedFrom } : {}),
        ...(call.argsRepaired?.length ? { argsRepaired: call.argsRepaired } : {}),
        ...(call.argsTruncated?.length ? { argsTruncated: call.argsTruncated } : {}),
      },
      site.actor,
      envExtra(site),
    ),
  ]);

  // Tier: forbidden is enforced first (a forbidden tool never runs for software, whatever its args).
  if (tool.tier === 'forbidden' && !site.human) {
    return block(
      site,
      call,
      'tier',
      `forbidden tool '${tool.name}' attempted by ${site.role}`,
      forbiddenExplanation(tool.name),
      undefined,
      tool.system,
    );
  }
  if (!opts.availableToRole) {
    return block(
      site,
      call,
      'arg_validation',
      `tool '${tool.name}' is not available to role ${site.role}`,
      `Tool '${tool.name}' is not available to you. Use only the tools you were given.`,
      undefined,
      tool.system,
    );
  }
  const bad = await checkCall(site, tool, call, args);
  if (bad) return bad;

  // Idempotency: a retry with a key that already succeeded returns the ORIGINAL result, with no new mutation and
  // no new proposal; a retry of a request still awaiting approval does not raise a second proposal.
  if (tool.idempotencyKey) {
    const prior = priorIdempotentCall(site, tool, getPointer(args, tool.idempotencyKey), call.id);
    if (prior?.kind === 'done') {
      await ctx.append([
        ctx.draft(
          'agent.tool_result',
          {
            ...prior.result,
            toolCallId: call.id,
            deduplicatedFrom: prior.toolCallId,
          },
          site.actor,
          envExtra(site),
        ),
      ]);
      return {
        ok: true,
        isError: false,
        content: wrapped(tool.name, tool.system, {
          deduplicated: true,
          note: `requestId already used by call ${prior.toolCallId}; this is its original result (nothing was done twice).`,
          result: prior.result.result ?? prior.result.resultPreview,
        }),
        data: prior.result.result,
      };
    }
    if (prior?.kind === 'pending') {
      const msg = `requestId already used by call ${prior.toolCallId}, still awaiting a human decision (${prior.approvalId}); no second proposal was raised.`;
      await ctx.append([
        ctx.draft(
          'agent.tool_result',
          { toolCallId: call.id, tool: tool.name, ok: false, resultPreview: preview(msg) },
          site.actor,
          envExtra(site),
        ),
      ]);
      return {
        ok: false,
        isError: false,
        content: wrapped(tool.name, tool.system, { duplicate: true, message: msg }),
      };
    }
  }

  if (tool.tier !== 'propose') {
    return runHandler(site, tool, call, args, callEvent.seq);
  }

  // ---- propose: agent.proposal + ApprovalRecord, then block THIS caller until a decision arrives.
  const approvalId = ctx.ids.next('apr');
  const provenance = proposalProvenance(site, tool, agentChecks);
  const options =
    tool.name === 'request_decision'
      ? withOptionProvenance((args.options as DecisionOption[] | undefined) ?? [], provenance.dataAsOfMinute)
      : undefined;
  const summary = proposalSummary(tool.name, args);
  const reasoning = site.reasoning.slice(0, 2000);
  // Facts the proposal depends on (agents only): a change after approval emits `approval.invalidated`.
  const assumptions = site.human ? [] : deriveAssumptions(ctx.state, tool.name, args);
  let supersedesApprovalId: string | undefined;
  if (site.revision && !site.revision.used) {
    site.revision.used = true;
    supersedesApprovalId = site.revision.approvalId;
  }
  const [proposal] = (await ctx.append([
    ctx.draft(
      'agent.proposal',
      {
        approvalId,
        toolCallId: call.id,
        tool: tool.name,
        args,
        summary,
        reasoning,
        ...(options?.length ? { options } : {}),
        tier: 'propose',
        ...provenance,
        ...(assumptions.length ? { assumptions } : {}),
        ...(supersedesApprovalId ? { supersedesApprovalId } : {}),
      },
      site.actor,
      envExtra(site),
    ),
  ])) as RunEvent<'agent.proposal'>[];
  const record: ApprovalRecord = {
    runId: ctx.runId,
    approvalId,
    status: 'pending',
    agentRunId: site.agentRunId,
    role: site.role,
    toolCallId: call.id,
    tool: tool.name,
    args,
    summary,
    reasoning,
    ...(options?.length ? { options } : {}),
    proposalSeq: proposal.seq,
    createdAtMinute: proposal.simMinute,
  };
  await ctx.deps.store.putApproval(record);

  let decision: Decision;
  const auto = policyDecision(site.policy, tool.name, args, {
    rejectTools: ctx.rejectTools,
    scenario: ctx.scenario,
    scriptedDecision: site.scriptedDecision,
  });
  if (auto && site.policy !== 'human') decision = await applyPolicyDecision(ctx, record, site.policy, auto);
  else {
    // The simulation safety net applies to the human policy only (baseline and eval-auto decided above).
    const afterMs = site.policy === 'human' ? simAutoApproveAfterMs(ctx) : 0;
    decision = await ctx.waitForDecision(
      approvalId,
      afterMs > 0 ? { afterMs, approve: () => applySimulationAutoApproval(ctx, record) } : undefined,
    );
  }

  const who =
    decision.decidedBy.kind === 'human'
      ? `${decision.decidedBy.name} (${decision.decidedBy.roleTitle})`
      : decision.decidedBy.kind === 'policy'
        ? `policy:${decision.decidedBy.policy}`
        : decision.decidedBy.kind;
  if (decision.decision === 'reject') {
    const msg = `rejected by ${who}: ${decision.reason ?? 'no reason given'}`;
    await ctx.append([
      ctx.draft(
        'agent.tool_result',
        { toolCallId: call.id, tool: tool.name, ok: false, resultPreview: preview(msg) },
        site.actor,
        envExtra(site),
      ),
    ]);
    return {
      ok: false,
      isError: false,
      content: wrapped(tool.name, tool.system, { rejected: true, message: msg }),
    };
  }
  let finalArgs = args;
  if (decision.decision === 'edit') {
    finalArgs = (decision.editedArgs ?? args) as Record<string, unknown>;
    const badEdit = await checkCall(site, tool, call, finalArgs);
    if (badEdit) return badEdit;
  }
  // The deciding actor is the approver (ToolContext.approvedBy): domain handlers record it (e.g. `decidedBy` of an
  // engineering decision, `approvedBy` of a swap) and enforce human-only rules with it. In baseline mode the scripted
  // policy decision stands in for the named human who performs the step, so that human is the approver.
  const approvedBy: Actor =
    site.human && site.actor.kind === 'human' && decision.decidedBy.kind === 'policy'
      ? site.actor
      : decision.decidedBy;
  return runHandler(site, tool, call, finalArgs, callEvent.seq, decision, approvedBy);
}
