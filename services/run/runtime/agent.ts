/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * `runAgent(role, brief, ctx)`: THE ReAct loop (spec §6). Every role (orchestrator, specialists, author) runs
 * here; `delegate` recurses with a scoped context. Tiers, arg/ref validation and output screening are enforced in
 * code by `executeToolCall`; the loop only talks to the model and threads the results back.
 */
import {
  AgentReportSchema,
  CitationSchema,
  UNKNOWN,
  compileSchema,
  type AgentReport,
  type AgentRole,
  type Citation,
  type JSONSchema,
  type LlmMessage,
  type LlmToolSpec,
  type RoleDefinition,
  type ToolDefinition,
} from '@ica/schema';
import { redactStatusClaims, screenStatusClaims, type OutputFinding } from '../guardrails/screen-output';
import { validateAgainst } from '../guardrails/validate';
import { composeSystemPrompt, wrapScenarioData, wrapToolResult, wrapTwistData } from '../guardrails/wrap';
import { putTrace, traceLabel } from './trace';
import type { ApprovalPolicy } from './approvals';
import { AgentAbort, type RunContext } from './context';
import { executeToolCall, type CallSite, type ToolCallInput, type ToolCallResult } from './execute';
import { ORCHESTRATOR_RUNTIME_TOOLS, reportTool, type RuntimeSite } from './tools';
import { preview, summarise } from './util';

export interface RunAgentOptions {
  parentAgentRunId?: string;
  /** Deterministic path used for replay keys (`orchestrator`, `orchestrator/maintenance.1`, …). */
  agentPath?: string;
  /** Replace the role's reportSchema (twist mode). */
  reportSchema?: JSONSchema;
  /** Replace the role's domain tools (twist mode: none). */
  domainTools?: ToolDefinition[];
  /** Extra report validation (author: validateScenario). Errors are fed back as a tool result. */
  reportValidator?: (report: Record<string, unknown>) => string[];
  /** Retries after a validator failure before the report is accepted with its errors (default 2). */
  maxReportRetries?: number;
  /** The untrusted context block (default: the scenario, wrapped in `<scenario_data>`). */
  contextBlock?: string;
  policy?: ApprovalPolicy;
  /** Revision after `approval.invalidated`: this agent's first proposal supersedes that approval. */
  supersedesApprovalId?: string;
}

export type AgentOutcome =
  | {
      ok: true;
      agentRunId: string;
      report: AgentReport & Record<string, unknown>;
      validationErrors?: string[];
    }
  | { ok: false; agentRunId: string; reason: string; detail: string };

/**
 * The scenario as agents see it: no baseline, expected answers, KPI params or future twists. Maintenance record
 * fields the scenario does not state are "Unknown" (task 06 §1.6).
 */
export function agentScenarioView(ctx: RunContext): Record<string, unknown> {
  const s = ctx.scenario;
  const record = (
    m: { lastCheckType?: string; lastCheckDate?: string; defectHistory?: string[] } | undefined,
  ) => ({
    lastCheckType: m?.lastCheckType ?? UNKNOWN,
    lastCheckDate: m?.lastCheckDate ?? UNKNOWN,
    defectHistory: m?.defectHistory ?? UNKNOWN,
  });
  return {
    id: s.id,
    title: s.title,
    narrative: ctx.narrative,
    startSimTime: s.startSimTime,
    aircraft: { ...s.aircraft, maintenance: record(s.aircraft.maintenance) },
    trigger: s.trigger,
    world: { ...s.world, spares: s.world.spares.map((x) => ({ ...x, maintenance: record(x.maintenance) })) },
  };
}

export function scenarioBlock(ctx: RunContext): string {
  return wrapScenarioData(JSON.stringify(agentScenarioView(ctx), null, 1));
}

function simClockTag(ctx: RunContext): string {
  return `<sim_clock minute="${Math.round(ctx.sim.simMinute * 10) / 10}" time="${ctx.sim.simTime()}"/>`;
}

const citationValid = compileSchema(CitationSchema);

/** Coerce a validated report into the event contract (AgentReport + role extras). */
export function normaliseReport(input: Record<string, unknown>): AgentReport & Record<string, unknown> {
  const arr = (v: unknown) =>
    Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))) : [];
  const citations = (Array.isArray(input.citations) ? input.citations : []).filter(
    (c): c is Citation => citationValid(c).ok,
  );
  return {
    ...input,
    summary: typeof input.summary === 'string' ? input.summary : JSON.stringify(input.summary ?? ''),
    actionsTaken: arr(input.actionsTaken),
    openIssues: arr(input.openIssues),
    recommendations: arr(input.recommendations),
    citations,
  };
}

/** Optional on every propose-tier domain tool: what is still unverified (lifted off the args by the runtime). */
const UNRESOLVED_CHECKS_PROPERTY = {
  type: 'array',
  maxItems: 12,
  items: { type: 'string', maxLength: 300 },
  description:
    'What has not been verified yet, in plain words (shown to the approver on the decision card). Optional.',
};

/** Default scope of an agent recommendation: it authorises nothing by itself (task 06 §1.5). */
export const RECOMMENDATION_SCOPE = {
  authorises:
    'Nothing by itself: a recommendation for the duty manager. Any action it leads to is proposed and approved separately.',
  doesNotAuthorise: [
    'Any change to airline systems',
    'Any human-only decision (deferral, release, FDP extension, departure)',
  ],
};

/**
 * Provenance per recommendation (task 06 §1.5): the agent's own details win; the runtime fills the data as-of
 * minute, the scope (authorises nothing) and, when none are stated, the report's open issues as unresolved checks.
 */
export function withRecommendationDetails(
  report: AgentReport & Record<string, unknown>,
  asOfMinute: number,
): AgentReport & Record<string, unknown> {
  const given = Array.isArray(report.recommendationDetails) ? report.recommendationDetails : [];
  const details = report.recommendations.slice(0, 12).map((text, i) => {
    const d = given.find((x) => x.text === text) ?? given[i];
    const checks = d?.unresolvedChecks?.length ? d.unresolvedChecks : report.openIssues.slice(0, 12);
    return {
      text,
      unresolvedChecks: checks.map((c) => c.slice(0, 300)),
      approvalScope: d?.approvalScope ?? RECOMMENDATION_SCOPE,
      ...(d?.citations?.length ? { citations: d.citations.filter((c) => citationValid(c).ok) } : {}),
      dataAsOfMinute: d?.dataAsOfMinute ?? Math.round(asOfMinute * 100) / 100,
    };
  });
  return { ...report, recommendationDetails: details };
}

/** All agent-authored strings of a report (for status-claim screening). */
function reportTexts(report: AgentReport & Record<string, unknown>): string[] {
  const out = [report.summary, ...report.actionsTaken, ...report.openIssues, ...report.recommendations];
  const pr = report.provisionalReading as { text?: unknown } | undefined;
  if (typeof pr?.text === 'string') out.push(pr.text);
  return out;
}

/** Deep-replace status claims in every string of a report (last resort). */
function redactReport<T>(value: T): T {
  if (typeof value === 'string') return redactStatusClaims(value) as T;
  if (Array.isArray(value)) return value.map(redactReport) as T;
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, k === 'citations' ? v : redactReport(v)]),
    ) as T;
  return value;
}

/** Roles whose report text is screened for status-like defect claims (the model's reading is never a status). */
const STATUS_SCREENED_ROLES = new Set<AgentRole>(['maintenance']);

function toolSpecs(tools: ToolDefinition[]): LlmToolSpec[] {
  return tools.map((t) => {
    const props = (t.inputSchema as { properties?: Record<string, unknown> }).properties;
    const inputSchema =
      t.tier === 'propose' && props && !('unresolvedChecks' in props)
        ? { ...t.inputSchema, properties: { ...props, unresolvedChecks: UNRESOLVED_CHECKS_PROPERTY } }
        : t.inputSchema;
    return { name: t.name, description: t.description, inputSchema };
  });
}

export async function runAgent(
  role: AgentRole,
  brief: string,
  ctx: RunContext,
  opts: RunAgentOptions = {},
): Promise<AgentOutcome> {
  const def: RoleDefinition | undefined = ctx.registry.roles[role];
  const agentRunId = ctx.ids.next(`ar-${role}`);
  const agentPath = opts.agentPath ?? role;
  const actor = { kind: 'agent' as const, role };
  const envelope = (iteration?: number) => ({
    agentRunId,
    ...(opts.parentAgentRunId ? { parentAgentRunId: opts.parentAgentRunId } : {}),
    ...(iteration !== undefined ? { iteration } : {}),
  });
  if (!def) {
    await ctx.emit(
      'agent.aborted',
      { role, reason: 'error', detail: `unknown role ${role}` },
      actor,
      envelope(),
    );
    return { ok: false, agentRunId, reason: 'error', detail: `unknown role ${role}` };
  }

  // ---- tools: domain tools filtered by role.tools, plus the runtime tools.
  const domain = opts.domainTools ?? ctx.registry.tools.filter((t) => def.tools.includes(t.name));
  const report = reportTool(def, opts.reportSchema);
  const runtime = role === 'orchestrator' && !opts.domainTools ? ORCHESTRATOR_RUNTIME_TOOLS : [];
  const tools: ToolDefinition[] = [...domain, ...runtime, report];
  const byName = new Map(tools.map((t) => [t.name, t]));
  const registryByName = new Map(ctx.registry.tools.map((t) => [t.name, t]));
  const specs = toolSpecs(tools);
  const system = composeSystemPrompt(def.systemPrompt);
  const temperature = Math.min(def.temperature ?? ctx.llm.temperature, ctx.llm.temperature, 0.2);
  const maxIterations = Math.min(def.maxIterations ?? Infinity, ctx.limits.maxIterationsPerAgent);
  const policy: ApprovalPolicy = opts.policy ?? ctx.deps.approvalsPolicy ?? 'human';
  const maxReportRetries = opts.maxReportRetries ?? 2;
  let reportFailures = 0;
  let delegateCount = 0;
  const revision = opts.supersedesApprovalId
    ? { approvalId: opts.supersedesApprovalId, used: false }
    : undefined;
  let twistCursor = ctx.twistFeed.length;

  await ctx.emit(
    'agent.started',
    {
      role,
      brief: brief.slice(0, 4000),
      ...(opts.parentAgentRunId ? { parentAgentRunId: opts.parentAgentRunId } : {}),
    },
    actor,
    envelope(),
  );

  const messages: LlmMessage[] = [
    {
      role: 'user',
      content: [
        { type: 'text', text: opts.contextBlock ?? scenarioBlock(ctx), cache: true },
        { type: 'text', text: `${brief}\n\n${simClockTag(ctx)}` },
      ],
    },
  ];

  const abort = async (reason: string, detail: string): Promise<AgentOutcome> => {
    await ctx.emit(
      'agent.aborted',
      { role, reason: reason as never, detail: detail.slice(0, 1000) },
      actor,
      envelope(),
    );
    ctx.log({ msg: 'agent aborted', agentRunId, role, reason, detail });
    return { ok: false, agentRunId, reason, detail };
  };

  const runtimeSite = (childPath?: string): RuntimeSite => ({
    ctx,
    agentRunId,
    role,
    agentPath,
    childPath,
    delegate: async (subRole, subBrief, path) => {
      const out = await runAgent(subRole, subBrief, ctx, {
        parentAgentRunId: agentRunId,
        agentPath: path,
        policy,
      });
      return out.ok
        ? { ok: true, data: out.report }
        : { ok: false, error: `${subRole} agent stopped early (${out.reason}): ${out.detail}` };
    },
  });

  try {
    for (let iteration = 0; ; iteration++) {
      if (ctx.stopping) throw ctx.stoppedError();
      await ctx.waitWhilePaused();
      await ctx.sync();
      if (ctx.stopping) throw ctx.stoppedError();
      if (iteration >= maxIterations) {
        return await abort('iterations', `reached ${maxIterations} iterations without a report`);
      }

      // Twists that happened since this agent last looked are delivered as data.
      const last = messages[messages.length - 1];
      while (twistCursor < ctx.twistFeed.length) {
        const t = ctx.twistFeed[twistCursor++];
        last.content.push({ type: 'text', text: wrapTwistData(t.text, t.title) });
      }

      const t0 = ctx.clock.now();
      let routed: Awaited<ReturnType<RunContext['callModel']>>;
      const label = traceLabel(agentRunId, iteration);
      try {
        routed = await ctx.callModel({
          system,
          messages,
          tools: specs,
          maxTokens: ctx.llm.maxTokens,
          temperature,
          cacheHints: { system: true, tools: true, messages: true },
          meta: { runId: ctx.runId, agentRunId, role, iteration, agentPath },
        });
      } catch (err) {
        if (err instanceof AgentAbort) throw err;
        if (ctx.stopping) throw ctx.stoppedError();
        await putTrace(ctx.deps.traces, ctx.runId, label, {
          kind: 'llm',
          runId: ctx.runId,
          agentRunId,
          agentPath,
          role,
          iteration,
          provider: ctx.router.active.provider,
          model: ctx.router.active.model,
          latencyMs: ctx.clock.now() - t0,
          request: {
            model: ctx.router.active.model,
            system,
            messages,
            tools: specs,
            maxTokens: ctx.llm.maxTokens,
            temperature,
          },
          error: String((err as Error).message),
        }).catch(() => undefined);
        return await abort('error', `model call failed: ${(err as Error).message}`);
      }
      const { response, provider, model, latencyMs, costUsd } = routed;
      const traceKey = await putTrace(ctx.deps.traces, ctx.runId, label, {
        kind: 'llm',
        runId: ctx.runId,
        agentRunId,
        agentPath,
        role,
        iteration,
        provider,
        model,
        latencyMs,
        request: { model, system, messages, tools: specs, maxTokens: ctx.llm.maxTokens, temperature },
        response,
      });

      const names = response.toolCalls.map((c) => c.name);
      const text = response.text;
      await ctx.emit(
        'agent.thought',
        {
          text: text.slice(0, 8000),
          summary:
            summarise(text) || (names.length ? summarise(`Calling ${names.join(', ')}.`) : '(no output)'),
        },
        actor,
        {
          ...envelope(iteration),
          usage: {
            ...response.usage,
            costUsd,
            model,
            provider,
          },
          latencyMs,
          traceKey,
        },
      );

      messages.push({
        role: 'assistant',
        content: [
          ...(text ? [{ type: 'text' as const, text }] : []),
          ...response.toolCalls.map((c) => ({
            type: 'tool_use' as const,
            id: c.id,
            name: c.name,
            input: c.input,
          })),
        ],
        ...(response.providerContent ? { providerContent: response.providerContent } : {}),
      });

      if (!response.toolCalls.length) {
        messages.push({
          role: 'user',
          content: [
            {
              type: 'text',
              text: `No tool was called. Continue using your tools; when your work is complete, call the report tool.\n${simClockTag(ctx)}`,
            },
          ],
        });
        continue;
      }

      const site: CallSite = {
        ctx,
        agentRunId,
        parentAgentRunId: opts.parentAgentRunId,
        role,
        agentPath,
        actor,
        iteration,
        reasoning: text,
        policy,
        runtime: runtimeSite(),
        ...(revision ? { revision } : {}),
      };

      // Delegates start concurrently (Promise.all); other calls run in order; results keep the call order.
      const results = new Map<string, Promise<ToolCallResult>>();
      let reportCall: ToolCallInput | undefined;
      const run = (c: ToolCallInput, s: CallSite) => {
        const def = byName.get(c.name) ?? registryByName.get(c.name);
        return executeToolCall(s, def, c, { availableToRole: byName.has(c.name) });
      };
      for (const c of response.toolCalls) {
        if (c.name === 'delegate' && byName.has('delegate')) {
          const sub = typeof c.input?.role === 'string' ? c.input.role : 'unknown';
          const childPath = `${agentPath}/${sub}.${++delegateCount}`;
          const p = run(c, { ...site, runtime: runtimeSite(childPath) });
          p.catch(() => undefined);
          results.set(c.id, p);
        }
      }
      for (const c of response.toolCalls) {
        if (results.has(c.id)) continue;
        if (c.name === 'report' && !reportCall) {
          reportCall = c;
          continue;
        }
        results.set(c.id, Promise.resolve(await run(c, site)));
      }
      const settled = await Promise.allSettled([...results.values()]);
      const failure = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected');
      if (failure) throw failure.reason;

      const toolResults: LlmMessage['content'] = [];
      let accepted: (AgentReport & Record<string, unknown>) | undefined;
      let acceptedErrors: string[] | undefined;
      for (const c of response.toolCalls) {
        if (reportCall && c.id === reportCall.id) {
          const r = await handleReport(c);
          toolResults.push({ type: 'tool_result', toolUseId: c.id, content: r.content, isError: r.isError });
          if (r.report) {
            accepted = r.report;
            acceptedErrors = r.errors;
          }
          continue;
        }
        const res = await results.get(c.id);
        if (res)
          toolResults.push({
            type: 'tool_result',
            toolUseId: c.id,
            content: res.content,
            isError: res.isError,
          });
        else {
          toolResults.push({
            type: 'tool_result',
            toolUseId: c.id,
            content: wrapToolResult('runtime', JSON.stringify({ error: 'duplicate report call ignored' })),
            isError: true,
          });
        }
      }
      if (accepted) {
        await ctx.emit('agent.report', { role, report: accepted }, actor, envelope(iteration));
        return {
          ok: true,
          agentRunId,
          report: accepted,
          ...(acceptedErrors?.length ? { validationErrors: acceptedErrors } : {}),
        };
      }
      toolResults.push({ type: 'text', text: simClockTag(ctx) });
      messages.push({ role: 'user', content: toolResults });

      async function handleReport(c: ToolCallInput): Promise<{
        content: string;
        isError: boolean;
        report?: AgentReport & Record<string, unknown>;
        errors?: string[];
      }> {
        const res = await executeToolCall(site, report, c, { availableToRole: true });
        if (!res.ok) return { content: res.content, isError: true };
        const input = (c.input ?? {}) as Record<string, unknown>;
        const errors = opts.reportValidator?.(input) ?? [];
        if (errors.length && reportFailures < maxReportRetries) {
          reportFailures++;
          return {
            content: wrapToolResult(
              'runtime:report',
              JSON.stringify({
                error: 'report rejected: fix these errors and call report again',
                errors: errors.slice(0, 30),
              }),
            ),
            isError: true,
          };
        }
        let normalised = normaliseReport(input);
        // Status-like defect claims (deferrable, airworthy, AOG…) are blocked: the model's interpretation is a
        // provisional reading only. The agent redrafts; after the retries the claims are redacted.
        if (STATUS_SCREENED_ROLES.has(role)) {
          const findings: OutputFinding[] = reportTexts(normalised).flatMap(screenStatusClaims);
          if (findings.length) {
            await ctx.emit(
              'guardrail.blocked',
              {
                layer: 'output_screen',
                tool: 'report',
                reason: `status-like claim in the ${role} report (${[...new Set(findings.map((f) => f.pattern))].join(', ')}): a model reading is provisional; certifying staff decide`,
                excerpt: findings[0]!.excerpt.slice(0, 200),
                toolCallId: c.id,
              },
              actor,
              envelope(iteration),
            );
            if (reportFailures < maxReportRetries) {
              reportFailures++;
              return {
                content: wrapToolResult(
                  'runtime:report',
                  JSON.stringify({
                    error:
                      'report rejected by output screening: do not state a status (deferrable, non-deferrable, airworthy, AOG, fit to fly). Put your interpretation in provisionalReading {text, confidence, unconfirmed: true} and say that certifying staff decide. Call report again.',
                    findings: findings.map((f) => f.excerpt).slice(0, 5),
                  }),
                ),
                isError: true,
              };
            }
            normalised = redactReport(normalised);
          }
        }
        normalised = withRecommendationDetails(normalised, ctx.sim.simMinute);
        const check = validateAgainst(AgentReportSchema as unknown as JSONSchema, normalised);
        if (!check.ok)
          return {
            content: wrapToolResult('runtime:report', JSON.stringify({ error: check.errors })),
            isError: true,
          };
        return {
          content: wrapToolResult('runtime:report', '{"accepted":true}'),
          isError: false,
          report: normalised,
          errors,
        };
      }
    }
  } catch (err) {
    if (err instanceof AgentAbort) {
      if (err.runLevel) ctx.stop('stopped', err.detail, err.reason);
      return abort(err.reason, err.detail);
    }
    if (ctx.stopping) return abort('stopped', ctx.abortDetail || 'run ended');
    return abort(
      'error',
      `${(err as Error).message}`.slice(0, 500) + ` ${preview((err as Error).stack ?? '', 200)}`,
    );
  }
}
