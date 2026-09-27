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
  RunEvent,
  SystemMutation,
  ToolContext,
  ToolDefinition,
  ToolOutcome,
} from '@ica/schema';
import { getPointer, screenOutput, textAtPointers } from '../guardrails/screen-output';
import { validateRefs, validateToolArgs } from '../guardrails/validate';
import { wrapToolResult } from '../guardrails/wrap';
import { applyPolicyDecision, policyDecision, type ApprovalPolicy } from './approvals';
import { AgentAbort, type Decision, type RunContext } from './context';
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
  const v = validateToolArgs(tool, args);
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
        ...(ctx.latestKpis ? { kpis: deepClone(ctx.latestKpis) } : {}),
        simMinute: ctx.sim.simMinute,
        state: deepClone(ctx.state),
        scenario: ctx.scenario,
        knowledge: ctx.knowledge,
        rng: ctx.rng,
        log: (msg) => ctx.log({ agentRunId: site.agentRunId, tool: tool.name, msg }),
      };
      outcome = await tool.handler(args, toolCtx);
    }
  } catch (err) {
    if (err instanceof AgentAbort) throw err;
    outcome = { ok: false, error: `tool failed: ${(err as Error).message}` };
  }
  if (!outcome.ok) {
    await ctx.append([
      ctx.draft(
        'agent.tool_result',
        { toolCallId: call.id, tool: tool.name, ok: false, resultPreview: preview(outcome.error) },
        site.actor,
        envExtra(site),
      ),
    ]);
    return { ok: false, isError: true, content: wrapped(tool.name, tool.system, { error: outcome.error }) };
  }
  const mutations: SystemMutation[] = outcome.mutations ?? [];
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

/** The full pipeline for one tool call. `tool` is undefined for unknown tool names. */
export async function executeToolCall(
  site: CallSite,
  tool: ToolDefinition | undefined,
  call: ToolCallInput,
  opts: { availableToRole: boolean },
): Promise<ToolCallResult> {
  const { ctx } = site;
  ctx.countToolCall();
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
  else decision = await ctx.waitForDecision(approvalId);

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
