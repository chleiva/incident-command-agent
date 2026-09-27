/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import type { RunEvent } from '@ica/schema';
import { harness } from '../systems/testing';
import { pageEngineer } from '../systems/engineers/index';
import { applyMutations } from '../systems/util';
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

  it('the engineer-ETA shift moves the named engineer when they are on the way', () => {
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
    expect(later.errors).toEqual([]);
    expect(later.mutations[0]!.after).toMatchObject({ etaMinute: 52 });
    expect(later.infos[0]).toMatch(/Ada Pennick \(eng-1\) is held up: ETA minute 12 → 52/);
  });

  it('resolves the engineer at apply time: the one actually travelling, not the id in the scenario', () => {
    // live 2026-09-27: "shift: engineers/engineers/eng-man-b1a has no numeric 'etaMinute'" — a different engineer
    // had been paged, and the twist silently did nothing.
    const h = harness();
    h.state.engineers.engineers['eng-2'] = {
      ...h.state.engineers.engineers['eng-2']!,
      status: 'travelling',
      etaMinute: 30,
    };
    const eff = {
      op: 'shift',
      system: 'engineers',
      entity: 'engineers',
      id: 'eng-1',
      field: 'etaMinute',
      minutes: 40,
    } as const;
    const r = applyTwistEffects(h.state, [eff], 5);
    expect(r.errors).toEqual([]);
    expect(r.mutations).toHaveLength(1);
    expect(r.mutations[0]).toMatchObject({ id: 'eng-2', after: { etaMinute: 70 } });
    expect(r.infos[0]).toMatch(/Tomas Wrenfield \(eng-2\)/);
  });

  it('prefers the engineer assigned to the work order over a backup', () => {
    const h = harness();
    const eng = h.state.engineers.engineers;
    eng['eng-1'] = { ...eng['eng-1']!, status: 'travelling', etaMinute: 50, pageReason: 'backup' };
    eng['eng-2'] = { ...eng['eng-2']!, status: 'travelling', etaMinute: 60 };
    h.state.mne.workOrders['WO-1'] = {
      id: 'WO-1',
      tail: 'AX-FXA',
      task: 'Damage assessment',
      status: 'assigned',
      assignedEngineerId: 'eng-2',
      createdAtMinute: 1,
      estimatedDurationMin: 30,
      progressPct: 0,
    };
    const eff = {
      op: 'shift',
      system: 'engineers',
      entity: 'engineers',
      id: 'eng-x',
      field: 'etaMinute',
      minutes: 40,
    } as const;
    expect(applyTwistEffects(h.state, [eff], 5).mutations[0]).toMatchObject({
      id: 'eng-2',
      after: { etaMinute: 100 },
    });
  });

  it('with nobody on the way, the delay waits for the next page (never a silent skip)', () => {
    const h = harness();
    const eff = {
      op: 'shift',
      system: 'engineers',
      entity: 'engineers',
      id: 'eng-1',
      field: 'etaMinute',
      minutes: 40,
    } as const;
    const r = applyTwistEffects(h.state, [eff], 5);
    expect(r.errors).toEqual([]);
    expect(r.mutations[0]).toMatchObject({ id: 'eng-1', after: { pendingEtaDelayMin: 40 } });
    expect(r.infos[0]).toMatch(/next engineer paged will arrive 40 min later/);
    // the next page (of any engineer) carries the delay and clears it
    const s = applyMutations(h.state, r.mutations);
    s.engineers.engineers['eng-2'] = { ...s.engineers.engineers['eng-2']!, status: 'available' };
    const page = pageEngineer(s, h.scenario, { engineerId: 'eng-2', station: 'MAN' }, 6, () => 0);
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    expect(page.value.delayedByMin).toBe(40);
    expect(page.value.engineer.etaMinute).toBe(6 + 5 + 40); // 5-min walk (rng 0) + 40
    const after = applyMutations(s, page.mutations);
    expect(after.engineers.engineers['eng-1']!.pendingEtaDelayMin).toBeUndefined();
    expect(page.mutations.map((m) => m.id).sort()).toEqual(['eng-1', 'eng-2']);
  });

  it('an engineer already on site: a clear note, no change', () => {
    const h = harness();
    h.state.engineers.engineers['eng-1'] = {
      ...h.state.engineers.engineers['eng-1']!,
      status: 'on_site',
      etaMinute: 12,
    };
    const eff = {
      op: 'shift',
      system: 'engineers',
      entity: 'engineers',
      id: 'eng-1',
      field: 'etaMinute',
      minutes: 40,
    } as const;
    const r = applyTwistEffects(h.state, [eff], 20);
    expect(r.errors).toEqual([]);
    expect(r.mutations).toEqual([]);
    expect(r.infos[0]).toMatch(/no longer applies: Ada Pennick \(eng-1\) is already on site/);
  });
});
