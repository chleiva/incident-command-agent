/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * `executeRun` (world engine + orchestrator, or baseline replay) and `runAuthor` (free text → Scenario Author).
 */
import { getPublicScenario } from '@ica/scenarios';
import {
  ENTITY_KEY,
  validateScenario,
  type AuthorResult,
  type ExecuteRunInput,
  type KpiSnapshot,
  type RunDeps,
  type RunMode,
  type RunTotals,
  type Scenario,
  type ScreeningResult,
  type SystemMutation,
  type SystemState,
} from '@ica/schema';
import { MemoryStore } from '@ica/store';
import minimalScenario from '@ica/schema/fixtures/scenario.minimal.json' with { type: 'json' };
import { runBaseline } from '../baseline/run';
import { screenText, type ScreenInputOptions } from '../guardrails/screen-input';
import { wrapScenarioData } from '../guardrails/wrap';
import { WorldEngine } from '../world/engine';
import { runAgent } from './agent';
import type { ApprovalPolicy } from './approvals';
import { RunContext } from './context';
import { defaultRegistry, type Registry } from './registry';
import { RUNTIME_TOOL_NAMES } from './tools';
import { demonstrateForbidden, reviseAfterInvalidation } from './presenter';
import { createTwistStructurer } from './twist-mode';
import { deepClone } from './util';

/** Eval override: patch (or create) a seeded entity, e.g. to inject text into a mock tool result. */
export interface SeedPatch {
  system: string;
  entity: string;
  /** Existing entity id to patch; omit with `record` to create. `*` patches every entity of that map. */
  id?: string;
  patch?: Record<string, unknown>;
  record?: Record<string, unknown>;
}

export interface ExecuteRunOptions {
  registry?: Registry;
  /** Use this scenario instead of looking it up (evals apply `scenarioPatch` first). */
  scenario?: Scenario;
  seedPatches?: SeedPatch[];
  rejectTools?: string[];
  log?: (line: Record<string, unknown>) => void;
  /** Called with the context once created (tests, CLI live log). */
  onContext?: (ctx: RunContext) => void;
}

export interface RunResult {
  runId: string;
  status: 'completed' | 'aborted' | 'failed' | 'skipped';
  reason?: 'report' | 'horizon' | 'stopped';
  abortReason?: string;
  totals?: RunTotals;
  finalKpis?: KpiSnapshot;
  error?: string;
}

export const ORCHESTRATOR_BRIEF = `The incident described in the scenario data has just been triggered. You are the incident orchestrator. Open the incident, set the objective, and coordinate the specialists (maintenance, ground, flightops, passenger, record) by delegating to them in parallel where their work is independent. Make sure passengers are informed early, route decisions that belong to humans to them, and call report when the incident is under control or every remaining action is waiting on a human.`;

export const AUTHOR_BRIEF = `Turn the scenario request in the scenario data block into a complete, schema-valid Scenario JSON (schemaVersion 1) for the fictional carrier Northwind Air (NWD flight numbers, NW-XXX tails, real IATA airports, fictional people). Use validate_scenario until it is valid, then call report with the scenario in the "scenario" field.`;

export function toolNamesFor(registry: Registry): string[] {
  return [...registry.tools.map((t) => t.name), ...RUNTIME_TOOL_NAMES];
}

/** Apply eval seed patches to a seeded state (pure). */
export function applySeedPatches(state: SystemState, patches: SeedPatch[]): SystemState {
  const st = deepClone(state) as unknown as Record<
    string,
    Record<string, Record<string, Record<string, unknown>>>
  >;
  for (const p of patches) {
    const map = ((st[p.system] ??= {})[p.entity] ??= {});
    if (p.record) {
      const key = (ENTITY_KEY as Record<string, Record<string, string>>)[p.system]?.[p.entity] ?? 'id';
      const id = String(p.record[key] ?? p.id ?? `x-${Object.keys(map).length + 1}`);
      map[id] = { ...p.record, [key]: id };
    } else if (p.patch) {
      const ids = p.id === '*' || p.id === undefined ? Object.keys(map) : [p.id];
      for (const id of ids) if (map[id]) map[id] = { ...map[id], ...p.patch };
    }
  }
  return st as unknown as SystemState;
}

function seedMutations(state: SystemState): SystemMutation[] {
  const out: SystemMutation[] = [];
  for (const [system, entities] of Object.entries(state)) {
    for (const [entity, rows] of Object.entries(entities as Record<string, Record<string, unknown>>)) {
      for (const [id, after] of Object.entries(rows)) {
        out.push({
          system: system as SystemMutation['system'],
          entity,
          id,
          op: 'create',
          after: after as Record<string, unknown>,
        });
      }
    }
  }
  return out;
}

async function loadScenario(deps: RunDeps, scenarioId: string): Promise<Scenario | null> {
  return getPublicScenario(scenarioId) ?? (await deps.store.getScenario(scenarioId));
}

async function failRun(deps: RunDeps, runId: string, error: string, where: string): Promise<RunResult> {
  const meta = await deps.store.getRun(runId);
  const simMinute = meta?.simMinute ?? 0;
  try {
    await deps.store.append(runId, [
      {
        type: 'run.failed',
        actor: { kind: 'world' },
        simMinute,
        simTime: new Date(Date.parse('2026-01-01T00:00:00Z')).toISOString(),
        payload: { error: error.slice(0, 1000), where },
      },
    ]);
  } catch {
    /* the run row may be gone; still update meta below */
  }
  await deps.store
    .updateRun(runId, { status: 'failed', error: error.slice(0, 500), endedAt: new Date().toISOString() })
    .catch(() => undefined);
  return { runId, status: 'failed', error };
}

/** Run a whole scenario. Resolves when the run ends; never throws for run-level failures (they become events). */
export async function executeRunWith(
  input: ExecuteRunInput,
  opts: ExecuteRunOptions = {},
): Promise<RunResult> {
  const { runId, deps } = input;
  const registry = opts.registry ?? defaultRegistry();
  const meta = await deps.store.getRun(runId);
  if (!meta) throw new Error(`run not found: ${runId}`);
  if (meta.status !== 'created') {
    // Idempotency: Lambda retries async invocations; never run the same run twice.
    return { runId, status: 'skipped', error: `run status is '${meta.status}', not 'created'` };
  }
  const scenario = opts.scenario ?? (await loadScenario(deps, meta.scenarioId));
  if (!scenario)
    return failRun(deps, runId, `scenario not found: ${meta.scenarioId}`, 'executeRun.loadScenario');
  const valid = validateScenario(scenario);
  if (!valid.ok)
    return failRun(
      deps,
      runId,
      `invalid scenario: ${valid.errors.slice(0, 10).join('; ')}`,
      'executeRun.validate',
    );

  const mode: RunMode = meta.mode;
  const ctx = new RunContext({
    runId,
    scenario: valid.value,
    deps,
    registry,
    speed: meta.speed || 6,
    rejectTools: opts.rejectTools,
    signal: input.signal,
    log: opts.log,
  });
  opts.onContext?.(ctx);
  const world = { kind: 'world' as const };
  let engine: WorldEngine | undefined;
  try {
    const first = await deps.store.listEvents(runId, 0, 1);
    if (!first.events.length) {
      await ctx.emit(
        'run.created',
        {
          scenarioId: scenario.id,
          mode,
          ...(meta.pairedRunId ? { pairedRunId: meta.pairedRunId } : {}),
          speed: ctx.sim.speed,
          config: {
            provider: mode === 'baseline' ? 'none' : deps.llm.provider,
            model: mode === 'baseline' ? 'none' : deps.llm.model,
            limits: deps.llm.limits,
            ...(deps.llm.fallback ? { fallback: deps.llm.fallback } : {}),
          },
        },
        world,
      );
    }
    await deps.store.updateRun(runId, {
      status: 'running',
      ...(mode === 'agent' ? { llm: { provider: deps.llm.provider, model: deps.llm.model } } : {}),
    });

    // Input screening of the (untrusted) narrative: flagged text is neutralised, never obeyed.
    const screening = await screenText(scenario.narrative, { toolNames: toolNamesFor(registry) });
    if (screening.verdict !== 'clean') {
      ctx.narrative = screening.neutralisedText ?? scenario.narrative;
      await ctx.emit(
        'guardrail.blocked',
        {
          layer: 'input_screen',
          reason: `scenario narrative ${screening.verdict === 'rejected' ? 'contains injection patterns' : 'flagged'}; neutralised (${screening.findings.map((f) => f.pattern).join(', ')})`,
          excerpt: screening.findings[0]?.excerpt,
        },
        world,
      );
    }

    // Seed: run.started, then the seed as system.mutation events (chunks keep each transaction small).
    let seeded = registry.seedAll(valid.value, ctx.rng);
    if (opts.seedPatches?.length) seeded = applySeedPatches(seeded, opts.seedPatches);
    await ctx.emit('run.started', { speed: ctx.sim.speed }, world);
    const seedMuts = seedMutations(seeded);
    for (let i = 0; i < seedMuts.length; i += 40) await ctx.persist(seedMuts.slice(i, i + 40), world);

    engine = new WorldEngine(ctx, {
      toolNames: toolNamesFor(registry),
      wallClockLimit: mode === 'agent',
      ...(mode === 'agent'
        ? {
            structureTwist: createTwistStructurer(ctx),
            onInvalidated: (inv) => ctx.trackBackground(reviseAfterInvalidation(ctx, inv)),
          }
        : {}),
    });
    if (mode === 'agent') ctx.onDemoForbidden = (tool) => demonstrateForbidden(ctx, tool);
    const k0 = engine.computeKpis();
    ctx.latestKpis = k0;
    await ctx.emit('kpi.update', k0, world);

    const policy: ApprovalPolicy = mode === 'baseline' ? 'baseline' : (deps.approvalsPolicy ?? 'human');
    const driver =
      mode === 'baseline'
        ? runBaseline(ctx)
        : runAgent('orchestrator', ORCHESTRATOR_BRIEF, ctx, { policy, agentPath: 'orchestrator' }).then(
            async (out) => {
              // Revisions after an invalidated approval finish before the run ends.
              if (out.ok) await ctx.drainBackground();
              ctx.finish(out.ok ? 'report' : 'stopped');
            },
          );
    await Promise.all([driver.finally(() => ctx.finish('stopped')), engine.run()]);

    // Finalise.
    const finalKpis = engine.computeKpis();
    for (const a of await deps.store.listApprovals(runId, 'pending')) {
      await deps.store.putApproval({ ...a, status: 'expired' });
    }
    const reason = ctx.finishReason ?? 'stopped';
    const totals = ctx.totalsNow();
    await ctx.emit('run.completed', { reason, totals, finalKpis }, world);
    const limitAbort = ctx.abortReason && ctx.abortReason !== 'stopped';
    await deps.store.updateRun(runId, {
      status: limitAbort ? 'aborted' : 'completed',
      totals,
      simMinute: ctx.sim.simMinute,
      endedAt: new Date().toISOString(),
      ...(limitAbort ? { error: `${ctx.abortReason}: ${ctx.abortDetail}` } : {}),
    });
    ctx.log({ msg: 'run completed', reason, abortReason: ctx.abortReason, costUsd: totals.costUsd });
    return {
      runId,
      status: limitAbort ? 'aborted' : 'completed',
      reason,
      ...(ctx.abortReason ? { abortReason: ctx.abortReason } : {}),
      totals,
      finalKpis,
    };
  } catch (err) {
    ctx.finish('stopped');
    const msg = (err as Error).message ?? String(err);
    ctx.log({ msg: 'run failed', err: msg });
    try {
      await ctx.emit('run.failed', { error: msg.slice(0, 1000), where: 'executeRun' }, world);
    } catch {
      /* ignore */
    }
    await deps.store
      .updateRun(runId, {
        status: 'failed',
        error: msg.slice(0, 500),
        totals: ctx.totalsNow(),
        endedAt: new Date().toISOString(),
      })
      .catch(() => undefined);
    return { runId, status: 'failed', error: msg, totals: ctx.totalsNow() };
  } finally {
    ctx.dispose();
  }
}

// ------------------------------------------------------------------------------------------------ author
export interface RunAuthorOptions {
  registry?: Registry;
  screen?: ScreenInputOptions;
}

function extractScenario(report: Record<string, unknown>): unknown {
  return report.scenario ?? null;
}

/** Free text → screening → Scenario Author agent → validated scenario (up to 2 retries on validation errors). */
export async function runAuthorWith(
  text: string,
  deps: RunDeps,
  opts: RunAuthorOptions = {},
): Promise<AuthorResult> {
  const registry = opts.registry ?? defaultRegistry();
  const screening: ScreeningResult = await screenText(text, {
    toolNames: toolNamesFor(registry),
    ...opts.screen,
  });
  if (screening.verdict === 'rejected') {
    return { errors: ['input rejected by screening: it contains instruction-like text'], screening };
  }
  const runId = `author-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
  const store = new MemoryStore();
  await store.createRun({
    runId,
    scenarioId: 'author',
    scenarioTitle: 'Scenario authoring',
    mode: 'agent',
    status: 'running',
    createdAt: new Date().toISOString(),
    simMinute: 0,
    lastSeq: 0,
    totals: { inputTokens: 0, outputTokens: 0, costUsd: 0, toolCalls: 0, iterations: 0, wallMs: 0 },
    speed: 6,
  });
  const ctx = new RunContext({
    runId,
    scenario: minimalScenario as unknown as Scenario,
    deps: { ...deps, store, bus: undefined },
    registry,
  });
  let lastErrors: string[] = [];
  try {
    const input = screening.verdict === 'neutralised' ? (screening.neutralisedText ?? text) : text;
    const out = await runAgent('author', AUTHOR_BRIEF, ctx, {
      agentPath: 'author',
      contextBlock: wrapScenarioData(input),
      policy: 'eval-auto',
      maxReportRetries: 2,
      reportValidator: (report) => {
        const sc = extractScenario(report);
        if (!sc)
          return (lastErrors = [
            'report.scenario is missing: put the full scenario JSON in the "scenario" field',
          ]);
        const v = validateScenario(sc);
        return (lastErrors = v.ok ? [] : v.errors);
      },
    });
    if (!out.ok) return { errors: [`author agent stopped: ${out.reason}: ${out.detail}`], screening };
    const sc = extractScenario(out.report);
    const v = validateScenario(sc);
    if (!v.ok) return { errors: v.errors.length ? v.errors : lastErrors, screening };
    return { scenario: { ...v.value, visibility: 'private' }, screening };
  } finally {
    ctx.dispose();
  }
}
