/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Headless runner: `npm run run:local -- --scenario s01-pushback-tug-contact [--mode baseline]
 *   [--model claude-haiku-4-5] [--policy eval-auto] [--provider scripted|replay --trace <dir>] [--speed 6]
 *   [--horizon 60] [--budget 0.50] [--real-time]`
 * Uses MemoryStore; prints a compact live log; writes `.local/runs/{runId}.events.json`. Scenario = a shipped id, a
 * path to a scenario JSON, or `fixture` (the schema's minimal fixture). Live provider spend is appended to
 * `.local/dev-spend.json` (separate from the eval ledger).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { getPublicScenario } from '@ica/scenarios';
import {
  foldEvents,
  validateEvent,
  validateScenario,
  type LlmProvider,
  type ProviderId,
  type RunEvent,
  type Scenario,
} from '@ica/schema';
import { EnvSecretStore, MemoryEventBus, MemoryStore, MemoryTraceStore } from '@ica/store';
import minimal from '@ica/schema/fixtures/scenario.minimal.json' with { type: 'json' };
import { executeRun } from './index';
import { loadKnowledgeIndex } from './knowledge/index';
import { llmConfigFromEnv } from './llm/config';
import { createReplayProvider, loadTraceDir } from './llm/replay';
import { createScriptedProvider } from './llm/scripted';
import { demoScript } from './runtime/demo-script';
import { VirtualClock, realClock } from './world/clock';

const LIVE: ProviderId[] = ['anthropic', 'openai', 'bedrock'];

async function resolveScenario(ref: string): Promise<Scenario> {
  if (ref === 'fixture' || ref === (minimal as { id: string }).id) return minimal as unknown as Scenario;
  const pub = getPublicScenario(ref);
  if (pub) return pub;
  const raw = JSON.parse(await readFile(resolve(ref), 'utf8')) as unknown;
  const v = validateScenario(raw);
  if (!v.ok) throw new Error(`invalid scenario ${ref}:\n  ${v.errors.join('\n  ')}`);
  return v.value;
}

function compact(e: RunEvent): string | null {
  const t = `[m${e.simMinute.toFixed(1).padStart(5)}] #${String(e.seq).padStart(4)}`;
  const who = e.agentRunId ? ` ${e.agentRunId}` : '';
  switch (e.type) {
    case 'agent.started':
      return `${t}${who} ▶ ${e.payload.role}: ${e.payload.brief.slice(0, 80)}`;
    case 'agent.thought':
      return `${t}${who} 💭 ${e.payload.summary}${e.usage ? `  ($${e.usage.costUsd.toFixed(4)})` : ''}`;
    case 'agent.tool_call':
      return `${t}${who} → ${e.payload.tool} [${e.payload.tier}]`;
    case 'agent.tool_result':
      return `${t}${who} ← ${e.payload.tool} ${e.payload.ok ? 'ok' : 'ERR'} ${e.payload.resultPreview.slice(0, 80)}`;
    case 'agent.proposal':
      return `${t}${who} ? proposal ${e.payload.approvalId}: ${e.payload.summary.slice(0, 80)}`;
    case 'approval.decision':
      return `${t} ✓ ${e.payload.approvalId} ${e.payload.decision} by ${e.payload.decidedBy.kind}`;
    case 'guardrail.blocked':
      return `${t}${who} ⛔ ${e.payload.layer}: ${e.payload.reason.slice(0, 100)}`;
    case 'agent.report':
      return `${t}${who} ■ report: ${e.payload.report.summary.slice(0, 100)}`;
    case 'agent.aborted':
      return `${t}${who} ✗ aborted (${e.payload.reason}): ${e.payload.detail.slice(0, 100)}`;
    case 'world.twist':
      return `${t} ⚡ twist: ${e.payload.title}`;
    case 'baseline.action':
      return `${t} 👤 ${e.payload.actor}: ${e.payload.tool}`;
    case 'llm.fallback':
      return `${t} ↯ fallback ${e.payload.from.model} → ${e.payload.to.model}`;
    case 'run.completed':
      return `${t} ■ run completed (${e.payload.reason}) cost $${e.payload.totals.costUsd.toFixed(4)}`;
    case 'run.failed':
      return `${t} ✗ run failed: ${e.payload.error}`;
    default:
      return null;
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      scenario: { type: 'string', default: 'fixture' },
      mode: { type: 'string', default: 'agent' },
      provider: { type: 'string' },
      model: { type: 'string' },
      policy: { type: 'string', default: 'eval-auto' },
      trace: { type: 'string' },
      speed: { type: 'string', default: '6' },
      horizon: { type: 'string' },
      budget: { type: 'string' },
      'real-time': { type: 'boolean', default: false },
      quiet: { type: 'boolean', default: false },
      knowledge: { type: 'string' },
    },
  });
  const scenario = await resolveScenario(values.scenario!);
  const mode = values.mode === 'baseline' ? 'baseline' : 'agent';
  const env = {
    ...process.env,
    ...(values.provider ? { LLM_PROVIDER: values.provider } : {}),
    ...(values.model ? { LLM_MODEL: values.model } : {}),
    ...(values.horizon ? { RUN_HORIZON_MIN: values.horizon } : {}),
    ...(values.budget ? { RUN_BUDGET_USD: values.budget } : {}),
  };
  const llm = llmConfigFromEnv(env);
  const live = mode === 'agent' && LIVE.includes(llm.provider);
  const clock = live || values['real-time'] ? realClock : new VirtualClock();
  const providers: Partial<Record<ProviderId, LlmProvider>> = {};
  if (llm.provider === 'scripted')
    providers.scripted = createScriptedProvider(demoScript(), { clock, latencyMs: 1500 });
  if (llm.provider === 'replay') {
    if (!values.trace) throw new Error('--provider replay needs --trace <dir>');
    providers.replay = createReplayProvider(await loadTraceDir(resolve(values.trace)), {
      clock,
      simulateLatency: true,
    });
  }

  const bus = new MemoryEventBus();
  const store = new MemoryStore({ bus });
  const runId = `local-${scenario.id.slice(0, 24)}-${Date.now().toString(36)}`;
  await store.putScenario(scenario);
  await store.createRun({
    runId,
    scenarioId: scenario.id,
    scenarioTitle: scenario.title,
    mode,
    status: 'created',
    createdAt: new Date().toISOString(),
    simMinute: 0,
    lastSeq: 0,
    totals: { inputTokens: 0, outputTokens: 0, costUsd: 0, toolCalls: 0, iterations: 0, wallMs: 0 },
    speed: Number(values.speed) || 6,
  });
  if (!values.quiet) {
    bus.subscribe(runId, (events) => {
      for (const e of events) {
        const line = compact(e);
        if (line) console.log(line);
      }
    });
  }
  const knowledge = await loadKnowledgeIndex({ source: 'fs', path: values.knowledge ?? 'data/fixtures' });
  console.log(
    `run ${runId}: scenario ${scenario.id}, mode ${mode}, provider ${mode === 'baseline' ? 'none' : `${llm.provider}/${llm.model}`}, budget $${llm.limits.budgetUsd}, clock ${clock === realClock ? 'real' : 'virtual'}`,
  );
  const result = await executeRun(
    {
      runId,
      deps: {
        store,
        traces: new MemoryTraceStore(),
        knowledge,
        llm,
        clock,
        bus,
        secrets: new EnvSecretStore(),
        providers,
        approvalsPolicy: values.policy as 'human' | 'baseline' | 'eval-auto',
      },
    },
    { scenario, log: () => undefined },
  );

  const { events } = await store.listEvents(runId, 0, 1_000_000);
  const invalid = events.map((e) => validateEvent(e)).filter((r) => !r.ok);
  const projection = foldEvents(events);
  const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), '../..');
  const out = join(repoRoot, '.local', 'runs', `${runId}.events.json`);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(events, null, 1));
  if (live && result.totals) {
    const spendFile = join(repoRoot, '.local', 'dev-spend.json');
    let spend: { entries: unknown[] } = { entries: [] };
    try {
      spend = JSON.parse(await readFile(spendFile, 'utf8')) as typeof spend;
    } catch {
      /* first run */
    }
    spend.entries.push({
      date: new Date().toISOString(),
      runId,
      model: llm.model,
      costUsd: result.totals.costUsd,
    });
    await writeFile(spendFile, JSON.stringify(spend, null, 2));
  }
  console.log(
    `\n${result.status} (${result.reason ?? result.error ?? ''}) · ${events.length} events · ${invalid.length} invalid · projection status ${projection.meta.status} · cost $${(result.totals?.costUsd ?? 0).toFixed(4)}\nevents → ${out}`,
  );
  if (invalid.length || result.status === 'failed') process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
