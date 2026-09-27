/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** Audit fixtures for stories and tests: the recorded s01 run's audit and its fixture LLM traces. */
import type { RunEvent, RunMeta } from '@ica/schema/browser';
import type { AuditRun, LoadedTrace } from '../../audit/audit';
import { mockAudit, mockLlmTrace } from '../../mocks/auditTraces';
import { RECORDINGS } from '../../mocks/recordings';

const S01 = RECORDINGS.find((r) => r.scenario.id === 's01-pushback-tug-contact')!;
const events = S01.agent;

const meta: RunMeta = {
  runId: events[0]!.runId,
  scenarioId: S01.scenario.id,
  scenarioTitle: S01.scenario.title,
  mode: 'agent',
  status: 'completed',
  createdAt: events[0]!.wallTime,
  simMinute: events.at(-1)!.simMinute,
  lastSeq: events.at(-1)!.seq,
  totals: { inputTokens: 0, outputTokens: 0, costUsd: 0, toolCalls: 0, iterations: 0, wallMs: 0 },
  speed: 6,
};

const page = mockAudit(meta, S01.scenario, events, null, null);
const { entries, nextCursor: _n, ...rest } = page;

export const AUDIT_META = meta;
export const AUDIT_RUN: AuditRun = { ...rest, entries };

export function fixtureTrace(key: string): unknown {
  const thought = events.find(
    (e): e is RunEvent<'agent.thought'> => e.type === 'agent.thought' && e.traceKey === key,
  );
  if (!thought) throw new Error(`no fixture trace for ${key}`);
  return mockLlmTrace(events, thought, S01.scenario);
}

export async function fixtureLoadTrace(key: string): Promise<LoadedTrace> {
  const trace = fixtureTrace(key);
  return { key, sizeBytes: JSON.stringify(trace).length, trace };
}

export const FIRST_LLM = entries.find((e) => e.kind === 'llm')!;
export const FIRST_TOOL = entries.find((e) => e.kind === 'tool' && e.result !== undefined)!;
export const PROPOSED_TOOL = entries.find((e) => e.kind === 'tool' && e.decision)!;
