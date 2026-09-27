/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Demo review (Agents view): turn numbers run continuously per column across re-briefs, the re-brief is a divider
 * row, deduplicated/cached calls are a note on the original row (not a row of their own), the orchestrator column
 * says when the run resumed after a system error, and new backend markers read well in headlines (≤ 60 chars).
 */
import type { RunEvent } from '@ica/schema/browser';
import { describe, expect, it } from 'vitest';
import { buildAgentsShowcase } from '../mocks/agentsShowcase';
import { RECORDINGS } from '../mocks/recordings';
import { alreadyPaged, headline, HEADLINE_MAX } from './headline';
import { deriveAgents, isRecordingFailure, RECOVERY_HEADLINE, turnCount } from './rows';

const S01 = RECORDINGS[0]!;
const SHOWCASE = buildAgentsShowcase();

describe('continuous turn numbers per column across re-briefs', () => {
  const m = deriveAgents(SHOWCASE);
  const ground = m.columns.find((c) => c.role === 'ground')!;

  it('the column holds two agent runs of the same role', () => {
    expect(ground.agentRunIds.length).toBe(2);
  });

  it('T1…Tn across the whole run: the second brief continues after the first brief’s last turn', () => {
    const [first, second] = ground.agentRunIds;
    const tagged = ground.rows.filter((r) => r.columnTurn !== undefined);
    const firstMax = Math.max(...tagged.filter((r) => r.agentRunId === first).map((r) => r.columnTurn!));
    const secondTurns = tagged.filter((r) => r.agentRunId === second).map((r) => r.columnTurn!);
    expect(secondTurns.length).toBeGreaterThan(0);
    expect(Math.min(...secondTurns)).toBe(firstMax + 1);
    // Per-run turns restart at 1 (facts and reasoning still use them); the shown numbers never repeat.
    expect(tagged.find((r) => r.agentRunId === second)!.turn).toBe(1);
    // Each run keeps its own order (runs may overlap in time); no number is shown twice for different turns.
    for (const id of ground.agentRunIds) {
      const own = tagged.filter((r) => r.agentRunId === id);
      expect(own.map((r) => r.columnTurn! - r.turn!)).toEqual(
        own.map(() => own[0]!.columnTurn! - own[0]!.turn!),
      );
    }
    const byNumber = new Map<number, string>();
    for (const r of tagged) {
      const k = `${r.agentRunId}#${r.turn}`;
      expect(byNumber.get(r.columnTurn!) ?? k).toBe(k);
      byNumber.set(r.columnTurn!, k);
    }
    expect(byNumber.size).toBe(turnCount(ground.rows));
  });

  it('the re-brief is a divider row: "Re-brief 2 from Orchestrator" (the delegation link row)', () => {
    const briefs = ground.rows.filter((r) => r.kind === 'brief');
    expect(briefs[0]!.headline).toBe('← brief from Orchestrator');
    expect(briefs[0]!.rebrief).toBeUndefined();
    expect(briefs[1]!.rebrief).toBe(2);
    expect(briefs[1]!.headline).toBe('Re-brief 2 from Orchestrator');
    expect(briefs[1]!.link?.direction).toBe('in');
  });

  it('single-run columns are unchanged (T equals the per-run turn)', () => {
    const mx = deriveAgents(S01.agent).columns.find((c) => c.role === 'maintenance')!;
    for (const r of mx.rows) if (r.turn !== undefined) expect(r.columnTurn).toBe(r.turn);
  });
});

// ------------------------------------------------------------------------------------------------ dedupe
const call = S01.agent.find(
  (e) => e.type === 'agent.tool_call' && e.payload.tool === 'page_engineer',
) as RunEvent<'agent.tool_call'>;
const result = S01.agent.find(
  (e) => e.type === 'agent.tool_result' && e.payload.toolCallId === call.payload.toolCallId,
) as RunEvent<'agent.tool_result'>;
const last = S01.agent.at(-1)!;

function appendDuplicate(opts: { markCall: boolean }): RunEvent[] {
  const dupId = `${call.payload.toolCallId}-dup`;
  const base = {
    runId: last.runId,
    simMinute: last.simMinute,
    simTime: last.simTime,
    wallTime: last.wallTime,
  };
  return [
    ...S01.agent,
    {
      ...call,
      ...base,
      seq: last.seq + 1,
      payload: { ...call.payload, toolCallId: dupId, ...(opts.markCall ? { deduplicated: true } : {}) },
    } as RunEvent,
    {
      ...result,
      ...base,
      seq: last.seq + 2,
      payload: { ...result.payload, toolCallId: dupId, deduplicatedFrom: call.payload.toolCallId },
    } as RunEvent,
  ];
}

describe('deduplicated / cached calls: "same result reused", not a new row', () => {
  const before = deriveAgents(S01.agent).columns.find((c) => c.role === 'maintenance')!.rows.length;

  for (const markCall of [true, false]) {
    it(`folds into the original row (${markCall ? 'marker on the call' : 'deduplicatedFrom on the result'})`, () => {
      const m = deriveAgents(appendDuplicate({ markCall }));
      const mx = m.columns.find((c) => c.role === 'maintenance')!;
      expect(mx.rows.length).toBe(before);
      const original = mx.rows.find((r) => r.call?.toolCallId === call.payload.toolCallId)!;
      expect(original.reused).toBe(1);
      // The original result stays.
      expect(original.result!.toolCallId).toBe(call.payload.toolCallId);
      expect(m.rowByKey.get(`tc-${last.seq + 1}`)).toBeUndefined();
    });
  }
});

// ------------------------------------------------------------------------------------------------ recovery
describe('resumed after a system error (additive event)', () => {
  it('a row in the orchestrator column', () => {
    const events = [
      ...S01.agent,
      {
        ...last,
        seq: last.seq + 1,
        type: 'run.resumed_after_error',
        actor: { kind: 'system' },
        agentRunId: undefined,
        payload: { attempt: 1 },
      } as unknown as RunEvent,
    ];
    const orch = deriveAgents(events).columns[0]!;
    const row = orch.rows.at(-1)!;
    expect(row.kind).toBe('recovery');
    expect(row.role).toBe('orchestrator');
    expect(row.headline).toBe('Resumed after a system error — re-briefed from the record');
    expect(RECOVERY_HEADLINE.length).toBeLessThanOrEqual(HEADLINE_MAX);
  });
});

// ------------------------------------------------------------------------------------------------ headlines
describe('new backend markers in headlines (≤ 60 chars)', () => {
  it('engineer already paged — ETA m{x}', () => {
    const variants = [
      { alreadyPaged: true, etaMinute: 34.4, engineerId: 'eng-1' },
      { status: 'already_paged', etaMinute: 34 },
      { note: 'Engineer already paged; no second page sent.', etaMinute: 34 },
    ];
    for (const r of variants) {
      expect(alreadyPaged(r)).toBe(true);
      const h = headline('page_engineer', { engineerId: 'eng-1', station: 'MAN' }, r, { minute: 20 });
      expect(h).toBe('Engineer already paged at MAN — ETA m34');
      // With the engineer's name (current backend): who, not where.
      expect(
        headline(
          'page_engineer',
          { engineerId: 'eng-1', station: 'MAN' },
          { ...r, name: 'Ari Voss' },
          { minute: 20 },
        ),
      ).toBe('Already paged Ari Voss — ETA m34');
      expect(h.length).toBeLessThanOrEqual(HEADLINE_MAX);
    }
    expect(alreadyPaged({ etaMinute: 12 })).toBe(false);
    expect(headline('page_engineer', { station: 'MAN' }, { etaMinute: 12 }, { minute: 3 })).toBe(
      'Paged an engineer at MAN — ETA 9 min',
    );
  });

  it('a "could not record" tool error reads as a system error, not the agent’s mistake', () => {
    expect(isRecordingFailure('The system could not record this action; try again.')).toBe(true);
    expect(isRecordingFailure('Unknown stand 99')).toBe(false);
    const dupId = 'tc-rec-fail';
    const events = [
      ...S01.agent,
      {
        ...call,
        seq: last.seq + 1,
        payload: { ...call.payload, toolCallId: dupId, args: { engineerId: 'eng-2' } },
      },
      {
        ...result,
        seq: last.seq + 2,
        payload: {
          toolCallId: dupId,
          tool: 'page_engineer',
          ok: false,
          resultPreview: 'The system could not record this action.',
        },
      },
    ] as RunEvent[];
    const row = deriveAgents(events).rowByKey.get(`tc-${last.seq + 1}`)!;
    expect(row.failed).toBe(true);
    expect(row.headline).toBe('Not recorded (system error): page an engineer');
    expect(row.headline.length).toBeLessThanOrEqual(HEADLINE_MAX);
  });
});
