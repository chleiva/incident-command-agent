/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import { EnvSecretStore, MemoryStore, MemoryTraceStore } from '@ica/store';
import minimal from '@ica/schema/fixtures/scenario.minimal.json' with { type: 'json' };
import type { Scenario } from '@ica/schema';
import { createRunHandler, STOP_MARGIN_MS } from './handler';

describe('Run Lambda handler', () => {
  it('stops gracefully (run.completed stopped) when < 60 s of Lambda time remain, loading knowledge once', async () => {
    const store = new MemoryStore();
    const scenario = minimal as unknown as Scenario;
    await store.putScenario(scenario);
    await store.createRun({
      runId: 'lambda-1',
      scenarioId: scenario.id,
      scenarioTitle: scenario.title,
      mode: 'baseline',
      status: 'created',
      createdAt: new Date().toISOString(),
      simMinute: 0,
      lastSeq: 0,
      totals: { inputTokens: 0, outputTokens: 0, costUsd: 0, toolCalls: 0, iterations: 0, wallMs: 0 },
      speed: 6,
    });
    let loads = 0;
    const handler = createRunHandler(() => ({
      store,
      traces: new MemoryTraceStore(),
      secrets: new EnvSecretStore({}),
      knowledge: async () => {
        loads++;
        return { search: async () => [] };
      },
      env: {},
      guardIntervalMs: 5,
    }));
    const r = await handler({ runId: 'lambda-1' }, { getRemainingTimeInMillis: () => STOP_MARGIN_MS - 1 });
    expect(r.status).toBe('completed');
    expect(r.reason).toBe('stopped');
    const { events } = await store.listEvents('lambda-1', 0);
    expect(events.at(-1)?.type).toBe('run.completed');
    expect(loads).toBe(1);
    // A retried async invocation never runs the same run twice.
    const again = await handler({ runId: 'lambda-1' });
    expect(again.status).toBe('skipped');
  });
});
