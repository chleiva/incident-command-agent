/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** Test harness: MemoryStore + VirtualClock + scripted provider + fake registry → `executeRun`. No network. */
import {
  DEFAULT_RUN_LIMITS,
  type ExecuteRunInput,
  type LlmProvider,
  type ProviderId,
  type RunDeps,
  type RunEvent,
  type RunLimits,
  type RunMode,
  type Scenario,
  type Store,
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
  /** The human policy's simulation safety net (real ms); tests default to 0 (off) unless they test it. */
  simAutoApproveAfterMs?: number;
  limits?: Partial<RunLimits>;
  latencyMs?: number;
  bus?: boolean;
  runOptions?: ExecuteRunOptions;
  speed?: number;
  /** Wrap the MemoryStore the run uses (fault injection); `h.store` stays the inner store for inspection. */
  wrapStore?: (store: MemoryStore) => Store;
  /** Self-recovery: `RunDeps.scheduleResume` (tests record the request and call `h.resume`). */
  scheduleResume?: RunDeps['scheduleResume'];
  /** Continuation: `RunDeps.maxRunContinuations`. */
  maxRunContinuations?: number;
}

export interface Harness {
  store: MemoryStore;
  traces: MemoryTraceStore;
  clock: VirtualClock;
  runId: string;
  deps: RunDeps;
  ctx?: RunContext;
  run(signal?: AbortSignal): Promise<RunResult>;
  /** A resumed invocation of the same run (what the Run Lambda does on `{runId, resume: {attempt}}`). */
  resume(attempt: number, signal?: AbortSignal): Promise<RunResult>;
  /** A continued invocation (what the Run Lambda does on `{runId, continuation: {attempt}}`). */
  continue(attempt: number, signal?: AbortSignal): Promise<RunResult>;
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
    store: opts.wrapStore ? opts.wrapStore(store) : store,
    ...(opts.scheduleResume ? { scheduleResume: opts.scheduleResume } : {}),
    ...(opts.maxRunContinuations !== undefined ? { maxRunContinuations: opts.maxRunContinuations } : {}),
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
    simAutoApproveAfterMs: opts.simAutoApproveAfterMs ?? 0,
    ...(bus ? { bus } : {}),
  };
  const invoke = (input: Omit<ExecuteRunInput, 'runId' | 'deps'>) =>
    executeRunWith(
      { runId, deps, ...input },
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
  const h: Harness = {
    store,
    traces,
    clock,
    runId,
    deps,
    run: (signal) => invoke(signal ? { signal } : {}),
    resume: (attempt, signal) => invoke({ resume: { attempt }, ...(signal ? { signal } : {}) }),
    continue: (attempt, signal) => invoke({ continuation: { attempt }, ...(signal ? { signal } : {}) }),
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
