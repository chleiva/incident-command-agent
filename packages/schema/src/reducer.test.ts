/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import sample from '../fixtures/run.sample.events.json' with { type: 'json' };
import {
  SYSTEM_ENTITIES,
  applyEvent,
  emptyProjection,
  foldEvents,
  validateEvent,
  type RunEvent,
} from './index';

const events = sample as unknown as RunEvent[];

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

describe('applyEvent over the sample run', () => {
  const final = foldEvents(events);

  it('tracks run meta and completion', () => {
    expect(final.runId).toBe('run-fixture-0001');
    expect(final.lastSeq).toBe(events.length);
    expect(final.meta.scenarioId).toBe('fx-minimal-cargo-door-sensor');
    expect(final.meta.mode).toBe('agent');
    expect(final.meta.status).toBe('completed');
    expect(final.meta.completedReason).toBe('report');
    expect(final.simMinute).toBe(19);
  });

  it('rebuilds system state from system.mutation events', () => {
    const s = final.systems;
    expect(Object.keys(s).sort()).toEqual(Object.keys(SYSTEM_ENTITIES).sort());
    expect(s.engineers.engineers['eng-1'].status).toBe('on_site');
    expect(s.pss.messages['msg-1'].status).toBe('sent');
    expect(s.pss.cohorts['c-connections'].firstInformedAtMinute).toBe(6.1);
    expect(s.mne.defects['def-1'].status).toBe('open');
    expect(Object.keys(s.record.timeline)).toEqual(['tl-1', 'tl-2']);
    expect(final.lastMutation?.id).toBe('tl-2');
  });

  it('tracks approvals and options decisions', () => {
    expect(final.pendingApprovalIds).toEqual([]);
    expect(final.approvals['apr-1'].status).toBe('approved');
    expect(final.approvals['apr-1'].role).toBe('passenger');
    expect(final.approvals['apr-2'].options).toHaveLength(3);
    expect(final.approvals['apr-2'].decision?.selectedOptionId).toBe('opt-rectify');
    expect(final.approvals['apr-2'].decision?.decidedBy).toEqual({
      kind: 'human',
      name: 'Sam Okafor',
      roleTitle: 'Duty Manager',
    });
  });

  it('marks agents awaiting approval while a proposal is pending', () => {
    const idx = events.findIndex((e) => e.type === 'agent.proposal');
    const mid = foldEvents(events.slice(0, idx + 1));
    expect(mid.pendingApprovalIds).toEqual(['apr-1']);
    expect(mid.agents['ar-pax-1'].status).toBe('awaiting_approval');
    const after = applyEvent(mid, events[idx + 1]);
    expect(after.agents['ar-pax-1'].status).toBe('running');
  });

  it('tracks agents, reports, twists, guardrails and KPIs', () => {
    expect(Object.values(final.agents).map((a) => [a.role, a.status])).toEqual([
      ['orchestrator', 'done'],
      ['maintenance', 'done'],
      ['passenger', 'done'],
    ]);
    expect(final.agents['ar-mx-1'].parentAgentRunId).toBe('ar-orch-1');
    expect(final.twists.map((t) => t.twistId)).toEqual(['tw-engineer-delayed']);
    expect(final.guardrailBlocks).toHaveLength(1);
    expect(final.guardrailBlocks[0]).toMatchObject({ layer: 'tier', tool: 'defer_defect' });
    expect(final.kpis?.safety.value.forbiddenAttempts).toBe(1);
    expect(final.totals.toolCalls).toBe(events.filter((e) => e.type === 'agent.tool_call').length);
  });
});

describe('reducer properties', () => {
  it('is pure: never mutates the input state or events', () => {
    const frozen = deepFreeze(JSON.parse(JSON.stringify(events)) as RunEvent[]);
    let s = deepFreeze(emptyProjection());
    for (const e of frozen) s = deepFreeze(applyEvent(s, e));
    expect(s.lastSeq).toBe(events.length);
  });

  it('is deterministic and ignores duplicates (seq <= lastSeq)', () => {
    const a = foldEvents(events);
    const b = foldEvents([...events, ...events.slice(10, 20)]);
    expect(b).toEqual(a);
    expect(applyEvent(a, events[5])).toBe(a);
  });

  it('can rebuild the state at any seq (time travel)', () => {
    const at = foldEvents(events.slice(0, 30));
    expect(at.lastSeq).toBe(30);
    expect(at.meta.status).toBe('running');
  });

  it('ignores unknown event types except for lastSeq', () => {
    const s = foldEvents(events.slice(0, 2));
    const e = { ...events[2], seq: 3, type: 'future.type', payload: {} } as unknown as RunEvent;
    const next = applyEvent(s, e);
    expect(next.lastSeq).toBe(3);
    expect(next.systems).toBe(s.systems);
  });

  it('removes entities on delete mutations', () => {
    const s = foldEvents(events.slice(0, 5));
    const del = {
      ...events[4],
      seq: 6,
      payload: { system: 'occ', entity: 'spares', id: 'AX-FXB', op: 'delete' },
    } as unknown as RunEvent;
    expect(applyEvent(s, del).systems.occ.spares['AX-FXB']).toBeUndefined();
  });
});

describe('self-recovery events', () => {
  const base = {
    runId: 'r',
    actor: { kind: 'world' },
    simTime: '2026-06-12T06:00:00Z',
    wallTime: '2026-06-12T06:00:00Z',
  };
  it('run.recovering then run.resumed_after_error: meta.recovery and status running again', () => {
    const recovering = {
      ...base,
      seq: 10,
      simMinute: 42.5,
      type: 'run.recovering',
      payload: { attempt: 1, reason: 'event log unwritable', maxAttempts: 2 },
    };
    const resumed = {
      ...base,
      seq: 11,
      simMinute: 42.5,
      type: 'run.resumed_after_error',
      payload: { attempt: 1, fromMinute: 42.5, pendingApprovals: 1 },
    };
    for (const e of [recovering, resumed]) expect(validateEvent(e).ok).toBe(true);
    const a = applyEvent(emptyProjection('r'), recovering as unknown as RunEvent);
    expect(a.meta.recovery).toEqual({
      status: 'recovering',
      attempt: 1,
      reason: 'event log unwritable',
      atMinute: 42.5,
      seq: 10,
    });
    const b = applyEvent(a, resumed as unknown as RunEvent);
    expect(b.meta.status).toBe('running');
    expect(b.meta.recovery).toEqual({
      status: 'resumed',
      attempt: 1,
      reason: 'event log unwritable',
      atMinute: 42.5,
      seq: 11,
    });
  });
  it('run.continuing then run.continued: meta.continuation, status unchanged, no recovery', () => {
    const continuing = {
      ...base,
      seq: 20,
      simMinute: 84,
      type: 'run.continuing',
      payload: { attempt: 1, maxAttempts: 12 },
    };
    const continued = {
      ...base,
      seq: 21,
      simMinute: 84,
      type: 'run.continued',
      payload: { attempt: 1, atSimMinute: 84, pendingApprovals: 2 },
    };
    for (const e of [continuing, continued]) expect(validateEvent(e).ok).toBe(true);
    const start = {
      ...emptyProjection('r'),
      meta: { ...emptyProjection('r').meta, status: 'paused' as const },
    };
    const a = applyEvent(start, continuing as unknown as RunEvent);
    expect(a.meta.continuation).toEqual({ status: 'continuing', attempt: 1, atMinute: 84, seq: 20 });
    const b = applyEvent(a, continued as unknown as RunEvent);
    expect(b.meta.status).toBe('paused');
    expect(b.meta.recovery).toBeUndefined();
    expect(b.meta.continuation).toEqual({ status: 'continued', attempt: 1, atMinute: 84, seq: 21 });
  });
  it('run.completed.note is projected as meta.completedNote', () => {
    const done = {
      ...base,
      seq: 30,
      simMinute: 200,
      type: 'run.completed',
      payload: {
        reason: 'stopped',
        note: 'Stopped after 3 hours of real time.',
        totals: { inputTokens: 0, outputTokens: 0, costUsd: 0, toolCalls: 0, iterations: 0, wallMs: 0 },
        finalKpis: emptyProjection('r').kpis,
      },
    };
    const p = applyEvent(emptyProjection('r'), done as unknown as RunEvent);
    expect(p.meta.completedNote).toBe('Stopped after 3 hours of real time.');
    expect(p.meta.completedReason).toBe('stopped');
  });
  it('system.error validates with a scope', () => {
    const e = {
      ...base,
      seq: 3,
      simMinute: 1,
      type: 'system.error',
      payload: { scope: 'tool', message: 'x', tool: 'page_engineer' },
    };
    expect(validateEvent(e).ok).toBe(true);
    expect(validateEvent({ ...e, payload: { scope: 'nope', message: 'x' } }).ok).toBe(false);
  });
});
