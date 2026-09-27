/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import type { RunEvent } from '@ica/schema';
import { harness } from '../systems/testing';
import { applyTwistEffects } from '../world/twists';
import { deriveAssumptions, findInvalidations, parseSource, readSource, revisionBrief } from './invalidation';

const env = (seq: number, type: string, payload: unknown, extra: Record<string, unknown> = {}) =>
  ({
    runId: 'r',
    seq,
    type,
    actor: { kind: 'agent', role: 'passenger' },
    agentRunId: 'ar-passenger-1',
    simMinute: seq,
    simTime: '2026-06-12T06:00:00Z',
    wallTime: '2026-06-12T06:00:00Z',
    payload,
    ...extra,
  }) as unknown as RunEvent;

describe('approval invalidation (pure)', () => {
  it('derives the engineer ETA (and a swap spare) as assumptions from mock state', () => {
    const h = harness();
    expect(deriveAssumptions(h.state, 'send_passenger_message', {})).toEqual([]);
    h.state.engineers.engineers['eng-1'] = {
      ...h.state.engineers.engineers['eng-1']!,
      status: 'travelling',
      etaMinute: 12,
    };
    expect(deriveAssumptions(h.state, 'propose_swap', { toTail: 'AX-FXB' })).toEqual([
      { key: 'engineerEtaMinute', value: 12, source: 'engineers/engineers/eng-1#etaMinute' },
      { key: 'spareAvailableFromMinute', value: 45, source: 'occ/spares/AX-FXB#availableFromMinute' },
    ]);
    expect(parseSource('engineers/engineers/eng-1#etaMinute')).toEqual({
      system: 'engineers',
      entity: 'engineers',
      id: 'eng-1',
      field: 'etaMinute',
    });
    expect(readSource(h.state, 'engineers/engineers/eng-1#etaMinute')).toBe(12);
    expect(readSource(h.state, 'engineers/engineers/nobody#etaMinute')).toBeNull();
  });

  it('flags an approved proposal once when an assumption changed; ignores rejected and pending ones', () => {
    const h = harness();
    h.state.engineers.engineers['eng-1'] = {
      ...h.state.engineers.engineers['eng-1']!,
      status: 'travelling',
      etaMinute: 52,
    };
    const assumptions = [
      { key: 'engineerEtaMinute', value: 12, source: 'engineers/engineers/eng-1#etaMinute' },
    ];
    const proposal = (seq: number, approvalId: string) =>
      env(seq, 'agent.proposal', {
        approvalId,
        toolCallId: `tc-${seq}`,
        tool: 'send_passenger_message',
        args: {},
        summary: 's',
        reasoning: 'r',
        assumptions,
      });
    const decision = (seq: number, approvalId: string, decision: string) =>
      env(seq, 'approval.decision', { approvalId, decision, decidedBy: { kind: 'world' } });
    const events = [
      proposal(1, 'apr-1'),
      decision(2, 'apr-1', 'approve'),
      proposal(3, 'apr-2'),
      decision(4, 'apr-2', 'reject'),
      proposal(5, 'apr-3'),
      env(6, 'system.mutation', { system: 'engineers', entity: 'engineers', id: 'eng-1', op: 'update' }),
    ];
    const found = findInvalidations(events, h.state, new Set());
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      approvalId: 'apr-1',
      tool: 'send_passenger_message',
      role: 'passenger',
      causedBySeq: 6,
      affected: [{ key: 'engineerEtaMinute', was: 12, now: 52 }],
    });
    expect(findInvalidations(events, h.state, new Set(['apr-1']))).toHaveLength(0);
    expect(revisionBrief(found[0]!)).toMatch(/engineerEtaMinute: 12 → 52/);
    const invalidated = env(7, 'approval.invalidated', { approvalId: 'apr-1', affectedAssumptions: [] });
    expect(findInvalidations([...events, invalidated], h.state, new Set())).toHaveLength(0);
  });

  it('the shift effect moves a future time and skips one that has passed', () => {
    const h = harness();
    h.state.engineers.engineers['eng-1'] = {
      ...h.state.engineers.engineers['eng-1']!,
      status: 'travelling',
      etaMinute: 12,
    };
    const eff = [
      { op: 'shift', system: 'engineers', entity: 'engineers', id: 'eng-1', field: 'etaMinute', minutes: 40 },
    ] as const;
    const later = applyTwistEffects(h.state, [...eff], 5);
    expect(later.mutations[0]!.after).toMatchObject({ etaMinute: 52 });
    const passed = applyTwistEffects(h.state, [...eff], 20);
    expect(passed.mutations).toHaveLength(0);
    expect(passed.errors[0]).toMatch(/already passed/);
    expect(applyTwistEffects(h.state, [{ ...eff[0], id: 'eng-2' }], 5).errors[0]).toMatch(/no numeric/);
  });
});
