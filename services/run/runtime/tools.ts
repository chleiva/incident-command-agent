/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Runtime tools (owned by task 02, `system: 'runtime'`): open_incident, set_objective, delegate, request_decision
 * and report. They are ordinary ToolDefinitions (schema, tier) whose behaviour needs the run, so the loop calls
 * `run(input, site)` instead of `handler`.
 */
import {
  AgentReportSchema,
  DecisionOptionSchema,
  SPECIALIST_ROLES,
  type AgentRole,
  type JSONSchema,
  type RoleDefinition,
  type SystemMutation,
  type ToolDefinition,
  type ToolOutcome,
} from '@ica/schema';
import type { Decision, RunContext } from './context';
import { placeholderProblems, relaxReportSchema } from './report';

export interface RuntimeSite {
  ctx: RunContext;
  agentRunId: string;
  role: AgentRole;
  agentPath: string;
  /** Deterministic path for the sub-agent of THIS delegate call (assigned in call order before running). */
  childPath?: string;
  /** Run a sub-agent (delegate). */
  delegate(role: AgentRole, brief: string, agentPath: string): Promise<ToolOutcome>;
}

export interface RuntimeToolDefinition extends ToolDefinition {
  runtime: true;
  run(
    input: Record<string, unknown>,
    site: RuntimeSite,
    extra: { decision?: Decision },
  ): Promise<ToolOutcome>;
}

const notDirect = async (): Promise<ToolOutcome> => ({
  ok: false,
  error: 'runtime tool: executed by the loop',
});

function timelineEntry(ctx: RunContext, text: string, source: string): SystemMutation {
  const id = ctx.ids.next('tl');
  return {
    system: 'record',
    entity: 'timeline',
    id,
    op: 'create',
    after: { id, atMinute: Math.round(ctx.sim.simMinute * 100) / 100, text: text.slice(0, 1000), source },
  };
}

export const openIncidentTool: RuntimeToolDefinition = {
  name: 'open_incident',
  description:
    'Open the incident record at the start of coordination. Writes the first timeline entry. Call once, first.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['title', 'summary'],
    properties: {
      title: { type: 'string', minLength: 1, maxLength: 160 },
      summary: { type: 'string', minLength: 1, maxLength: 1000 },
      severity: { type: 'string', enum: ['low', 'medium', 'high'] },
    },
  },
  tier: 'execute',
  system: 'runtime',
  roles: ['orchestrator'],
  mutates: true,
  runtime: true,
  handler: notDirect,
  async run(input, site) {
    const m = timelineEntry(
      site.ctx,
      `Incident opened: ${String(input.title)}. ${String(input.summary)}`,
      site.role,
    );
    return { ok: true, data: { opened: true, timelineId: m.id }, mutations: [m] };
  },
};

export const setObjectiveTool: RuntimeToolDefinition = {
  name: 'set_objective',
  description:
    'Record the current coordination objective (and an optional target sim minute) on the timeline.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['objective'],
    properties: {
      objective: { type: 'string', minLength: 1, maxLength: 500 },
      targetMinute: { type: 'number', minimum: 0, maximum: 1440 },
    },
  },
  tier: 'execute',
  system: 'runtime',
  roles: ['orchestrator'],
  mutates: true,
  runtime: true,
  handler: notDirect,
  async run(input, site) {
    const target = typeof input.targetMinute === 'number' ? ` (target minute ${input.targetMinute})` : '';
    const m = timelineEntry(site.ctx, `Objective: ${String(input.objective)}${target}`, site.role);
    return { ok: true, data: { recorded: true, timelineId: m.id }, mutations: [m] };
  },
};

export const delegateTool: RuntimeToolDefinition = {
  name: 'delegate',
  description:
    "Delegate a task to a specialist agent (maintenance, ground, flightops, passenger, record). Returns the specialist's structured report. Several delegate calls in one turn run in parallel.",
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['role', 'brief'],
    properties: {
      role: { type: 'string', enum: [...SPECIALIST_ROLES] },
      brief: { type: 'string', minLength: 1, maxLength: 2000 },
    },
  },
  tier: 'execute',
  system: 'runtime',
  roles: ['orchestrator'],
  mutates: false,
  runtime: true,
  handler: notDirect,
  async run(input, site) {
    const role = input.role as AgentRole;
    return site.delegate(role, String(input.brief), site.childPath ?? `${site.agentPath}/${role}`);
  },
};

export const requestDecisionTool: RuntimeToolDefinition = {
  name: 'request_decision',
  description:
    'Ask the human duty manager to decide between real alternatives. Provide 2–5 ranked options with metrics (time to departure, cost €, customer impact 0–100, compliance, constraints) and the recommended option id. Blocks until a human decides; returns the chosen option.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['question', 'options', 'recommendedOptionId'],
    properties: {
      question: { type: 'string', minLength: 1, maxLength: 500 },
      unresolvedChecks: {
        type: 'array',
        maxItems: 12,
        items: { type: 'string', maxLength: 300 },
        description: 'What has not been verified yet (shown on the decision card).',
      },
      options: {
        type: 'array',
        minItems: 2,
        maxItems: 5,
        items: JSON.parse(JSON.stringify(DecisionOptionSchema)) as JSONSchema,
      },
      recommendedOptionId: { type: 'string', minLength: 1 },
    },
  },
  tier: 'propose',
  system: 'runtime',
  roles: ['orchestrator'],
  mutates: true,
  approvalScope:
    'Choosing the selected option as the plan. Each action it leads to is still proposed and approved on its own.',
  approvalExclusions: [
    'Executing any action (swap, cancellation, messages, crew changes)',
    'Any human-only decision (deferral, release, FDP extension, departure)',
  ],
  runtime: true,
  handler: notDirect,
  async run(input, site, extra) {
    const options = (input.options as { id: string; label: string }[]) ?? [];
    const d = extra.decision;
    const selected = d?.selectedOptionId ?? String(input.recommendedOptionId);
    const opt = options.find((o) => o.id === selected);
    if (!opt) return { ok: false, error: `selected option '${selected}' is not one of the options` };
    const who =
      d?.decidedBy.kind === 'human' ? `${d.decidedBy.name} (${d.decidedBy.roleTitle})` : d?.decidedBy.kind;
    const m = timelineEntry(
      site.ctx,
      `Decision: ${String(input.question)} → ${opt.label} (decided by ${who ?? 'unknown'})`,
      'human',
    );
    return {
      ok: true,
      data: { selectedOptionId: opt.id, label: opt.label, decidedBy: d?.decidedBy },
      mutations: [m],
    };
  },
};

/**
 * The report tool for a role: its input schema is the role's reportSchema, relaxed (actionsTaken optional, unknown
 * keys kept as `extras`; see report.ts). Handled by the loop.
 */
export function reportTool(role: RoleDefinition, schemaOverride?: JSONSchema): RuntimeToolDefinition {
  return {
    name: 'report',
    description:
      'Finish your work: return your structured report of what you actually found and did (summary, open issues, recommendations, citations; actionsTaken is optional: the runtime adds the tool calls you executed). Never send placeholder or test content. Your turn ends when the report is accepted.',
    inputSchema: relaxReportSchema(
      schemaOverride ?? role.reportSchema ?? (AgentReportSchema as unknown as JSONSchema),
    ),
    tier: 'execute',
    system: 'runtime',
    roles: [role.role],
    mutates: false,
    runtime: true,
    handler: notDirect,
    async run(input) {
      const problems = placeholderProblems(input);
      if (problems.length)
        return {
          ok: false,
          error: `placeholder content is not allowed; report what you actually did (${problems.join('; ')}).`,
        };
      return { ok: true, data: input };
    },
  };
}

export const ORCHESTRATOR_RUNTIME_TOOLS = [
  openIncidentTool,
  setObjectiveTool,
  delegateTool,
  requestDecisionTool,
];

export const RUNTIME_TOOL_NAMES = [
  'open_incident',
  'set_objective',
  'delegate',
  'request_decision',
  'report',
];

export function isRuntimeTool(t: ToolDefinition): t is RuntimeToolDefinition {
  return (t as RuntimeToolDefinition).runtime === true;
}

/** Explanatory results for forbidden tools (the tier is enforced in code, never in the prompt). */
export const FORBIDDEN_EXPLANATIONS: Record<string, string> = {
  defer_defect:
    'Blocked: deferring a defect (MEL application) is reserved to certifying staff (Part-145 / ORO.MLR.105). Software cannot do it. Record the question for a human via request_decision or report it as an open issue.',
  release_aircraft:
    'Blocked: releasing the aircraft to service is reserved to certifying staff. Software cannot do it. Ask the certifying engineer via a human decision.',
  extend_crew_fdp:
    "Blocked: extending a flight duty period is the commander's discretion (ORO.FTL.205). Software cannot do it. Flag the FDP risk and propose alternatives (standby crew, swap) instead.",
  instruct_flight_crew:
    'Blocked: the commander flies the aircraft and decides its conduct. Software never instructs the flight deck. Prepare options and the ground (arrival services, handling, passengers) instead.',
  select_diversion_airport:
    "Blocked: whether and where to divert is the commander's decision. Rank options with rank_diversion_airports for the commander's consideration, then prepare the airport the commander chooses.",
  approve_overweight_landing:
    "Blocked: landing overweight is the commander's decision. Plan the overweight-landing inspection at the arrival station instead.",
};

/** The rule behind each forbidden tool and who holds the authority (shown on the "Blocked by autonomy policy" card). */
export const FORBIDDEN_RULES: Record<string, { rule: string; authority: string }> = {
  defer_defect: {
    rule: 'Deferral under the MEL is a certifying-staff decision (Part-145 / ORO.MLR.105)',
    authority: 'Certifying staff',
  },
  release_aircraft: {
    rule: 'Release to service needs a certificate of release by certifying staff (145.A.50)',
    authority: 'Certifying staff',
  },
  extend_crew_fdp: {
    rule: "Extending a flight duty period is the commander's discretion (ORO.FTL.205(f))",
    authority: 'Aircraft commander',
  },
  instruct_flight_crew: {
    rule: 'The commander has final authority over the conduct of the flight (CAT.GEN.MPA.105); the ground never instructs the flight deck',
    authority: 'Commander',
  },
  select_diversion_airport: {
    rule: "Whether and where to divert is the commander's decision (CAT.GEN.MPA.105); software prepares options only",
    authority: 'Commander',
  },
  approve_overweight_landing: {
    rule: "Landing above the maximum landing weight is the commander's decision (CAT.GEN.MPA.105)",
    authority: 'Commander',
  },
};

export function forbiddenRule(tool: string): { rule: string; authority: string } {
  return (
    FORBIDDEN_RULES[tool] ?? {
      rule: 'Autonomy matrix: this decision is reserved to humans and forbidden for software',
      authority: 'A named human decision-maker',
    }
  );
}

export function forbiddenExplanation(tool: string): string {
  return (
    FORBIDDEN_EXPLANATIONS[tool] ??
    `Blocked: '${tool}' is a decision reserved to humans and is forbidden for software. Record the question for a human via request_decision.`
  );
}
