/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import sample from '../fixtures/run.sample.events.json' with { type: 'json' };
import { EVENT_TYPES, eventSortKey, validateEvent, type RunEvent } from './index';

const events = sample as unknown as RunEvent[];

describe('run.sample.events.json', () => {
  it('has about 60 events, every one schema-valid', () => {
    expect(events.length).toBeGreaterThanOrEqual(55);
    for (const e of events) {
      const r = validateEvent(e);
      expect(r.ok ? [] : [e.seq, ...r.errors]).toEqual([]);
    }
  });

  it('is gap-free from seq 1 with non-decreasing sim time', () => {
    events.forEach((e, i) => expect(e.seq).toBe(i + 1));
    for (let i = 1; i < events.length; i++)
      expect(events[i].simMinute).toBeGreaterThanOrEqual(events[i - 1].simMinute);
  });

  it('covers the story the UI and evals rely on', () => {
    const types = events.map((e) => e.type);
    const count = (t: string) => types.filter((x) => x === t).length;
    expect(count('kpi.update')).toBe(3);
    expect(count('agent.started')).toBeGreaterThanOrEqual(3);
    for (const t of [
      'run.created',
      'agent.tool_call',
      'agent.tool_result',
      'system.mutation',
      'agent.proposal',
      'approval.decision',
      'world.twist',
      'guardrail.blocked',
      'run.completed',
    ]) {
      expect(types, t).toContain(t);
    }
    const delegates = events.filter((e) => e.type === 'agent.tool_call' && e.payload.tool === 'delegate');
    expect(delegates).toHaveLength(2);
    const withOptions = events.filter((e) => e.type === 'agent.proposal' && e.payload.options?.length);
    expect(withOptions).toHaveLength(1);
  });
});

describe('validateEvent', () => {
  it('rejects unknown types and bad payloads', () => {
    const base = events[0];
    expect(validateEvent({ ...base, type: 'nope' }).ok).toBe(false);
    const bad = validateEvent({ ...base, payload: { scenarioId: 1 } });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.some((m) => m.startsWith('/payload'))).toBe(true);
  });

  it('rejects seq 0 and missing actor', () => {
    const { actor: _actor, ...noActor } = events[1];
    expect(validateEvent({ ...events[1], seq: 0 }).ok).toBe(false);
    expect(validateEvent(noActor).ok).toBe(false);
  });

  it('allows additive payload fields (forward compatibility)', () => {
    expect(validateEvent({ ...events[1], payload: { ...events[1].payload, futureField: true } }).ok).toBe(
      true,
    );
  });

  it('lists every event type including the CLAUDE.md additions', () => {
    for (const t of [
      'twist.requested',
      'control.requested',
      'world.process',
      'llm.fallback',
      'run.paused',
      'run.resumed',
    ]) {
      expect(EVENT_TYPES).toContain(t);
    }
  });

  it('formats sort keys as EVT#{seq:08d}', () => {
    expect(eventSortKey(42)).toBe('EVT#00000042');
  });
});
