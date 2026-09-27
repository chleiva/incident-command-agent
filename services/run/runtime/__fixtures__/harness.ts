/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** Test harness: MemoryStore + VirtualClock + scripted provider + fake registry → `executeRun`. No network. */
import {
  DEFAULT_RUN_LIMITS,
  type LlmProvider,
  type ProviderId,
  type RunDeps,
  type RunEvent,
  type RunLimits,
  type RunMode,
  type Scenario,
} from '@ica/schema';
import { MemoryEventBus, MemoryStore, MemoryTraceStore } from '@ica/store';
import minimal from '@ica/schema/fixtures/scenario.minimal.json' with { type: 'json' };
import { createScriptedProvider, type ScriptFn } from '../../llm/scripted';
import { VirtualClock } from '../../world/clock';
import type { RunContext } from '../context';
import type { Registry } from '../registry';
import { executeRunWith, type ExecuteRunOptions, type RunResult } from '../run';
import { fakeKnowledge, fakeRegistry } from './registry';

export const MINIMAL = minimal as unknown as Scenario;

export interface HarnessOptions {
  script?: ScriptFn;
  providers?: Partial<Record<ProviderId, LlmProvider>>;
  provider?: ProviderId;
  fallback?: { provider: ProviderId; model: string };
  registry?: Registry;
  scenario?: Scenario;
  mode?: RunMode;
  policy?: RunDeps['approvalsPolicy'];
  limits?: Partial<RunLimits>;
  latencyMs?: number;
  bus?: boolean;
  runOptions?: ExecuteRunOptions;
  speed?: number;
}

export interface Harness {
  store: MemoryStore;
  traces: MemoryTraceStore;
  clock: VirtualClock;
  runId: string;
  deps: RunDeps;
  ctx?: RunContext;
  run(): Promise<RunResult>;
  events(): Promise<RunEvent[]>;
}

let n = 0;

export async function makeHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const clock = new VirtualClock();
  const bus = opts.bus ? new MemoryEventBus() : undefined;
  const store = new MemoryStore({ bus });
  const traces = new MemoryTraceStore();
  const scenario = opts.scenario ?? MINIMAL;
  const runId = `test-run-${++n}`;
  await store.createRun({
    runId,
    scenarioId: scenario.id,
    scenarioTitle: scenario.title,
    mode: opts.mode ?? 'agent',
    status: 'created',
    createdAt: new Date(0).toISOString(),
    simMinute: 0,
    lastSeq: 0,
    totals: { inputTokens: 0, outputTokens: 0, costUsd: 0, toolCalls: 0, iterations: 0, wallMs: 0 },
    speed: opts.speed ?? 6,
  });
  const provider = opts.provider ?? 'scripted';
  const providers: Partial<Record<ProviderId, LlmProvider>> = { ...opts.providers };
  if (opts.script && !providers[provider]) {
    providers[provider] = createScriptedProvider(opts.script, {
      clock,
      latencyMs: opts.latencyMs ?? 2000,
      id: provider,
    });
  }
  const deps: RunDeps = {
    store,
    traces,
    knowledge: fakeKnowledge(),
    llm: {
      provider,
      model: provider === 'scripted' ? 'claude-sonnet-5' : 'claude-sonnet-5',
      temperature: 0.2,
      maxTokens: 1024,
      limits: { ...DEFAULT_RUN_LIMITS, ...opts.limits },
      ...(opts.fallback ? { fallback: opts.fallback } : {}),
    },
    clock,
    providers,
    approvalsPolicy: opts.policy ?? 'eval-auto',
    ...(bus ? { bus } : {}),
  };
  const h: Harness = {
    store,
    traces,
    clock,
    runId,
    deps,
    async run() {
      return executeRunWith(
        { runId, deps },
        {
          registry: opts.registry ?? fakeRegistry(),
          scenario,
          log: () => undefined,
          ...opts.runOptions,
          onContext: (ctx) => {
            h.ctx = ctx;
            opts.runOptions?.onContext?.(ctx);
          },
        },
      );
    },
    async events() {
      return (await store.listEvents(runId, 0, 100_000)).events;
    },
  };
  return h;
}

export function ofType<T extends RunEvent['type']>(
  events: RunEvent[],
  type: T,
): Extract<RunEvent, { type: T }>[] {
  return events.filter((e) => e.type === type) as Extract<RunEvent, { type: T }>[];
}
