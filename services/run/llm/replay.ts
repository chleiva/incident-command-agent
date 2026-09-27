/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * `replay` provider (NFR-03 recorded-trace fallback): returns the recorded response for the same
 * `(agentPath, iteration)` key. A miss fails loudly (`ReplayMissError`). Makes CI evaluation free.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LlmProvider, LlmRequest, LlmResponse, WallClock } from '@ica/schema';
import { ReplayMissError } from './errors';

/** What the runtime writes to the TraceStore for every LLM call (and what fixtures contain). */
export interface LlmTrace {
  kind: 'llm';
  runId: string;
  agentRunId: string;
  agentPath: string;
  role: string;
  iteration: number;
  provider: string;
  model: string;
  latencyMs: number;
  request: Omit<LlmRequest, 'signal'>;
  response?: LlmResponse;
  error?: string;
}

export function replayKey(agentPath: string, iteration: number): string {
  return `${agentPath}#${iteration}`;
}

/** File name used for a recorded call inside `evals/fixtures/traces/{caseId}/`. */
export function traceFileName(agentPath: string, iteration: number): string {
  return `${agentPath.replace(/[^A-Za-z0-9.-]+/g, '_')}__${String(iteration).padStart(3, '0')}.json`;
}

export interface ReplayOptions {
  /** Re-apply the recorded latency on the run's clock (keeps interleaving close to the recording). */
  clock?: WallClock;
  simulateLatency?: boolean;
}

export interface ReplayProvider extends LlmProvider {
  size: number;
  used: Set<string>;
}

export function createReplayProvider(traces: LlmTrace[], opts: ReplayOptions = {}): ReplayProvider {
  const map = new Map<string, LlmTrace>();
  for (const t of traces) if (t.response) map.set(replayKey(t.agentPath, t.iteration), t);
  const used = new Set<string>();
  return {
    id: 'replay',
    size: map.size,
    used,
    async complete(req: LlmRequest): Promise<LlmResponse> {
      const key = replayKey(req.meta?.agentPath ?? req.meta?.role ?? '?', req.meta?.iteration ?? -1);
      const t = map.get(key);
      if (!t?.response) throw new ReplayMissError(key);
      used.add(key);
      if (opts.simulateLatency && opts.clock && t.latencyMs > 0) await opts.clock.sleep(t.latencyMs);
      const { raw: _raw, ...rest } = t.response;
      return structuredClone(rest);
    },
  };
}

/** Load every `*.json` LLM trace from a directory (e.g. `evals/fixtures/traces/{caseId}`). */
export async function loadTraceDir(dir: string): Promise<LlmTrace[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
  const out: LlmTrace[] = [];
  for (const f of files) {
    const t = JSON.parse(await readFile(join(dir, f), 'utf8')) as LlmTrace;
    if (t.kind === 'llm') out.push(t);
  }
  return out;
}
