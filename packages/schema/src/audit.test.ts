/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import { auditRunName, buildAuditEntries, isRunTraceKey, parseLlmTraceKey } from './audit';
import type { RunEvent } from './events';

const base = (seq: number, wallTime: string) => ({
  runId: 'r1',
  seq,
  actor: { kind: 'agent' as const, role: 'maintenance' as const },
  agentRunId: 'ar-maintenance-1',
  simMinute: seq,
  simTime: '2026-06-14T07:00:00.000Z',
  wallTime,
});

describe('audit helpers', () => {
  it('parses LLM trace keys and ignores payloads and exports', () => {
    expect(parseLlmTraceKey('traces/r1/ar-maintenance-1-i004.json')).toEqual({
      agentRunId: 'ar-maintenance-1',
      iteration: 4,
    });
    expect(parseLlmTraceKey('traces/r1/author-patch-i000.json')).toEqual({
      agentRunId: 'author-patch',
      iteration: 0,
    });
    expect(parseLlmTraceKey('traces/r1/12.payload.json')).toBeNull();
    expect(parseLlmTraceKey('traces/r1/export.json')).toBeNull();
  });

  it('accepts only keys of the run, without traversal', () => {
    expect(isRunTraceKey('r1', 'traces/r1/a-i000.json')).toBe(true);
    expect(isRunTraceKey('r1', 'traces/r2/a-i000.json')).toBe(false);
    expect(isRunTraceKey('r1', 'traces/r1/../r2/a.json')).toBe(false);
    expect(isRunTraceKey('r1', 'traces/r1//a.json')).toBe(false);
    expect(isRunTraceKey('r1', 'traces/r1/a/b.json')).toBe(false);
    expect(isRunTraceKey('r1', 'traces/r1/a.txt')).toBe(false);
  });

  it('places traces without an agent.thought by write time and derives the role from the agent run id', () => {
    const events = [
      {
        ...base(1, '2026-09-27T10:00:00.000Z'),
        type: 'agent.tool_call',
        payload: { toolCallId: 't1', tool: 'get_defect', system: 'mne', tier: 'execute', args: {} },
      },
      {
        ...base(2, '2026-09-27T10:00:10.000Z'),
        type: 'agent.tool_call',
        payload: { toolCallId: 't2', tool: 'get_defect', system: 'mne', tier: 'execute', args: {} },
      },
    ] as RunEvent[];
    const out = buildAuditEntries(events, [
      { key: 'traces/r1/ar-maintenance-1-i002.json', lastModified: '2026-09-27T10:00:05.000Z' },
      { key: 'traces/r1/ar-ground-1-i000.json' },
    ]);
    expect(out.map((e) => e.id)).toEqual([
      'tool:t1',
      'llm:traces/r1/ar-maintenance-1-i002.json',
      'tool:t2',
      'llm:traces/r1/ar-ground-1-i000.json',
    ]);
    expect(out[3]).toMatchObject({ role: 'ground', iteration: 0, unmatched: true });
  });

  it('names the run with the flight unless the title has it', () => {
    expect(auditRunName('Pushback damage', 'ACX101')).toBe('Pushback damage · ACX101');
    expect(auditRunName('Diversion: ACX124 at LGW', 'ACX124')).toBe('Diversion: ACX124 at LGW');
    expect(auditRunName('Pushback damage')).toBe('Pushback damage');
  });
});
