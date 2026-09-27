/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** Deterministic `scripted` provider for unit tests and the headless fixture runner. Never touches the network. */
import type { LlmProvider, LlmRequest, LlmResponse, LlmUsage, WallClock } from '@ica/schema';

export interface ScriptInfo {
  /** 0-based index of this call across the whole provider. */
  callIndex: number;
  agentPath: string;
  role: string;
  iteration: number;
}

/** A step: a (partial) response, or an error to throw (e.g. an `LlmHttpError(503)`). */
export type ScriptStep = Partial<LlmResponse> | { error: Error };
export type ScriptFn = (req: LlmRequest, info: ScriptInfo) => ScriptStep | Promise<ScriptStep>;

export const DEFAULT_SCRIPTED_USAGE: LlmUsage = {
  inputTokens: 1000,
  outputTokens: 100,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

let toolIdCounter = 0;

/** A tool call step helper. */
export function call(name: string, input: Record<string, unknown> = {}, id?: string) {
  return { id: id ?? `tu_${name}_${++toolIdCounter}`, name, input };
}

/** Build a response step: `step('thinking…', call('x', {...}), call('y'))`. */
export function step(text: string, ...toolCalls: ReturnType<typeof call>[]): Partial<LlmResponse> {
  return { text, toolCalls, stopReason: toolCalls.length ? 'tool_use' : 'end_turn' };
}

export function completeStep(s: Partial<LlmResponse>, model: string): LlmResponse {
  const toolCalls = s.toolCalls ?? [];
  return {
    text: s.text ?? '',
    toolCalls,
    usage: s.usage ?? DEFAULT_SCRIPTED_USAGE,
    stopReason: s.stopReason ?? (toolCalls.length ? 'tool_use' : 'end_turn'),
    model: s.model ?? model,
    ...(s.raw !== undefined ? { raw: s.raw } : {}),
  };
}

export interface ScriptedOptions {
  /** Simulated latency per call (uses the run's clock, so virtual time advances deterministically). */
  latencyMs?: number;
  clock?: WallClock;
  id?: 'scripted' | 'anthropic' | 'openai' | 'bedrock' | 'replay';
}

export interface ScriptedProvider extends LlmProvider {
  calls: { req: LlmRequest; info: ScriptInfo }[];
}

export function createScriptedProvider(script: ScriptFn, opts: ScriptedOptions = {}): ScriptedProvider {
  let n = 0;
  const calls: ScriptedProvider['calls'] = [];
  return {
    id: opts.id ?? 'scripted',
    calls,
    async complete(req: LlmRequest): Promise<LlmResponse> {
      const info: ScriptInfo = {
        callIndex: n++,
        agentPath: req.meta?.agentPath ?? req.meta?.role ?? 'unknown',
        role: req.meta?.role ?? 'unknown',
        iteration: req.meta?.iteration ?? 0,
      };
      calls.push({ req: { ...req, messages: JSON.parse(JSON.stringify(req.messages)) }, info });
      if (opts.latencyMs && opts.clock) await opts.clock.sleep(opts.latencyMs);
      const s = await script(req, info);
      if ('error' in s && s.error instanceof Error) throw s.error;
      return completeStep(s as Partial<LlmResponse>, req.model);
    },
  };
}

/**
 * Script keyed by agent path (e.g. `orchestrator`, `orchestrator/maintenance.1`) or role, indexed by iteration.
 * Falls back to `report` with a minimal valid AgentReport when the list is exhausted.
 */
export function scriptByAgent(
  table: Record<string, ScriptStep[] | ((iteration: number, req: LlmRequest) => ScriptStep)>,
): ScriptFn {
  return (req, info) => {
    const entry = table[info.agentPath] ?? table[info.role];
    if (typeof entry === 'function') return entry(info.iteration, req);
    const s = entry?.[info.iteration];
    if (s) return s;
    return step(
      'Done.',
      call('report', {
        summary: `${info.role} finished`,
        actionsTaken: [],
        openIssues: [],
        recommendations: [],
        citations: [],
      }),
    );
  };
}
