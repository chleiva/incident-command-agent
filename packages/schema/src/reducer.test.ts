/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import sample from '../fixtures/run.sample.events.json' with { type: 'json' };
import { SYSTEM_ENTITIES, applyEvent, emptyProjection, foldEvents, type RunEvent } from './index';

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
      payload: { system: 'occ', entity: 'spares', id: 'NW-FXB', op: 'delete' },
    } as unknown as RunEvent;
    expect(applyEvent(s, del).systems.occ.spares['NW-FXB']).toBeUndefined();
  });
});
