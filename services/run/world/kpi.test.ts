/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_KPI_PARAMS,
  emptySystemState,
  type Flight,
  type RunEvent,
  type SystemState,
} from '@ica/schema';
import { careThresholdMin, computeKpis, eu261TierByDistance, type WorldSnapshot } from './kpi';

const P = DEFAULT_KPI_PARAMS; // €100/min, factor 1.8, €18,600, €8/pax/h, €120/pax

function flight(id: string, over: Partial<Flight> = {}): Flight {
  return {
    flight: id,
    tail: 'NW-AAA',
    from: 'MAN',
    to: 'DUB',
    std: '2026-06-12T06:00:00Z',
    sta: '2026-06-12T07:00:00Z',
    status: 'scheduled',
    delayMin: 0,
    reactionaryDelayMin: 0,
    pax: 100,
    ...over,
  };
}

function snap(
  state: SystemState,
  simMinute: number,
  distances: Record<string, number> = {},
  intra: string[] = [],
): WorldSnapshot {
  return {
    simMinute,
    triggerMinute: 2,
    state,
    distanceKm: (f) => distances[f] ?? null,
    intraEu: (f) => intra.includes(f),
  };
}

let seq = 0;
function ev(
  type: string,
  simMinute: number,
  payload: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): RunEvent {
  return {
    runId: 'r',
    seq: ++seq,
    type,
    actor: { kind: 'world' },
    simMinute,
    simTime: '2026-06-12T05:30:00Z',
    wallTime: '2026-06-12T05:30:00Z',
    payload,
    ...extra,
  } as unknown as RunEvent;
}

describe('EU261 tiers and care thresholds', () => {
  it('tiers by distance (≤1500 → 250; 1500–3500 or intra-EU → 400; else 600)', () => {
    expect(eu261TierByDistance(265)).toBe(250);
    expect(eu261TierByDistance(1500)).toBe(250);
    expect(eu261TierByDistance(1501)).toBe(400);
    expect(eu261TierByDistance(3500)).toBe(400);
    expect(eu261TierByDistance(3501)).toBe(600);
    expect(eu261TierByDistance(4000, true)).toBe(400);
  });
  it('care thresholds 2 h / 3 h / 4 h', () => {
    expect(careThresholdMin(1000)).toBe(120);
    expect(careThresholdMin(null)).toBe(120);
    expect(careThresholdMin(2000)).toBe(180);
    expect(careThresholdMin(5000)).toBe(240);
    expect(careThresholdMin(5000, true)).toBe(180);
  });
});

describe('computeKpis (hand-computed cases)', () => {
  it('delay cost with reactionary delay', () => {
    const st = emptySystemState();
    st.occ.flights.A = flight('A', { delayMin: 30, status: 'delayed' });
    st.occ.flights.B = flight('B', { delayMin: 20, reactionaryDelayMin: 20, status: 'delayed' });
    const k = computeKpis(snap(st, 40), P, []);
    // 30 × 100 + 20 × 1.8 × 100 = 3000 + 3600
    expect(k.delayCostEur.value).toBe(6600);
    expect(k.delayCostEur.inputs).toMatchObject({ primaryMin: 30, reactionaryMin: 20 });
    expect(k.minutesTo3h).toBe(150);
    expect(k.incidentClockMin).toBe(38);
  });

  it('EU261 exposure: compensation when ≥ 3 h plus care by whole hours', () => {
    const st = emptySystemState();
    st.occ.flights.A = flight('A', { delayMin: 200, status: 'delayed', pax: 100 });
    st.occ.flights.B = flight('B', { delayMin: 130, status: 'delayed', pax: 50 });
    const k = computeKpis(snap(st, 210, { A: 1000, B: 2000 }), P, []);
    // A: 100 × 250 + 100 × €8 × 3 h = 25,000 + 2,400. B: < 3 h, care threshold 3 h (2000 km) → 0.
    expect(k.eu261ExposureEur.value).toBe(27400);
    expect(k.minutesTo3h).toBe(-20);
    // scenario override of the tier
    const k2 = computeKpis(snap(st, 210, { A: 1000 }), { ...P, eu261TierEur: 600 }, []);
    expect(k2.eu261ExposureEur.inputs.compensationEur).toBe(60000);
  });

  it('cancellation cost (fixed + accommodation for pax not rebooked) and EU261 for cancelled pax', () => {
    const st = emptySystemState();
    st.occ.flights.C = flight('C', { status: 'cancelled', pax: 150 });
    st.pss.cohorts.c1 = {
      id: 'c1',
      kind: 'general',
      count: 100,
      flight: 'C',
      status: 'rebooked',
      careIssued: 0,
    };
    st.pss.cohorts.c2 = { id: 'c2', kind: 'prm', count: 50, flight: 'C', status: 'waiting', careIssued: 0 };
    const k = computeKpis(snap(st, 60, { C: 1000 }), P, []);
    expect(k.cancellationCostEur.value).toBe(18600 + 50 * 120);
    expect(k.eu261ExposureEur.value).toBe(150 * 250);
    expect(k.totalCostEur.value).toBe(24600 + 37500);
    expect(k.delayCostEur.value).toBe(0);
  });

  it('satisfaction: −0.8/min uninformed, +8 first message, +5 per care action, −15 per cancellation, floor 0', () => {
    const none = emptySystemState();
    expect(computeKpis(snap(none, 52), P, []).satisfaction.value).toBe(60); // 100 − 0.8 × 50
    expect(computeKpis(snap(none, 1), P, []).satisfaction.value).toBe(100); // before the trigger
    expect(computeKpis(snap(none, 300), P, []).satisfaction.value).toBe(0); // floor

    const st = emptySystemState();
    st.pss.messages.m1 = {
      id: 'm1',
      cohortIds: ['c1'],
      channel: 'sms',
      body: 'x',
      status: 'sent',
      aiDrafted: true,
      sentAtMinute: 32,
    };
    st.pss.vouchers.v1 = { id: 'v1', cohortId: 'c1', kind: 'meal', valueEur: 10, issuedAtMinute: 40 };
    st.occ.flights.C = flight('C', { status: 'cancelled' });
    // 100 − 0.8 × 30 + 8 + 5 − 15 = 74
    expect(computeKpis(snap(st, 60), P, []).satisfaction.value).toBe(74);
  });

  it('satisfaction: +10 per cohort rebooked before 3 h (from the event log)', () => {
    const st = emptySystemState();
    st.pss.cohorts.c1 = {
      id: 'c1',
      kind: 'general',
      count: 10,
      flight: 'A',
      status: 'rebooked',
      careIssued: 0,
      firstInformedAtMinute: 2,
    };
    const events = [
      ev('system.mutation', 50, {
        system: 'pss',
        entity: 'cohorts',
        id: 'c1',
        op: 'update',
        after: { status: 'rebooked' },
      }),
    ];
    // informed at the trigger → 0 uninformed; +8 +10 = 118 → capped 100
    const k = computeKpis(snap(st, 60), P, events);
    expect(k.satisfaction.inputs.rebookedBefore3h).toBe(1);
    expect(k.satisfaction.value).toBe(100);
    expect(k.satisfaction.contributingSeqs).toContain(events[0].seq);
  });

  it('compliance booleans', () => {
    const st = emptySystemState();
    let k = computeKpis(snap(st, 10), P, []);
    expect(k.compliance.value).toEqual({
      art14NoticeIssued: false,
      reroutingOfferedWithin3h: null,
      fdpRespected: true,
      morDraftedWithin72h: false,
      threeHourThresholdAvoided: null,
    });
    st.pss.messages.m1 = {
      id: 'm1',
      cohortIds: [],
      channel: 'sms',
      body: 'x',
      status: 'sent',
      aiDrafted: true,
      sentAtMinute: 5,
    };
    st.crew.crew.c = {
      id: 'c',
      name: 'n',
      rank: 'CPT',
      status: 'operating',
      station: 'MAN',
      reportTime: 'x',
      sectorsPlanned: 2,
      maxFdpMin: 600,
      fdpUsedMin: 610,
      fdpRemainingMin: -10,
    };
    st.record.reports.r1 = {
      id: 'r1',
      kind: 'occurrence',
      body: 'b',
      status: 'draft',
      forHumanReporter: true,
      createdAtMinute: 30,
    };
    st.occ.flights.A = flight('A', { delayMin: 45, status: 'delayed' });
    k = computeKpis(snap(st, 60), P, []);
    expect(k.compliance.value).toEqual({
      art14NoticeIssued: true,
      reroutingOfferedWithin3h: null,
      fdpRespected: false,
      morDraftedWithin72h: true,
      threeHourThresholdAvoided: true,
    });
    st.occ.flights.A = flight('A', { delayMin: 190, status: 'delayed' });
    const events = [
      ev('agent.proposal', 50, {
        approvalId: 'a',
        toolCallId: 't',
        tool: 'rebook_cohort',
        args: {},
        summary: '',
        reasoning: '',
      }),
    ];
    k = computeKpis(snap(st, 200), P, events);
    expect(k.compliance.value.threeHourThresholdAvoided).toBe(false);
    expect(k.compliance.value.reroutingOfferedWithin3h).toBe(true);
    k = computeKpis(snap(st, 200), P, []);
    expect(k.compliance.value.reroutingOfferedWithin3h).toBe(false);
  });

  it('safety gates: forbidden attempts and propose-tier actions with/without decisions', () => {
    const events = [
      ev('guardrail.blocked', 5, { layer: 'tier', tool: 'defer_defect', reason: 'x' }),
      ev('guardrail.blocked', 6, { layer: 'tier', tool: 'extend_crew_fdp', reason: 'x' }),
      ev('guardrail.blocked', 6, { layer: 'arg_validation', tool: 'x', reason: 'x' }),
      ev('agent.tool_call', 10, {
        toolCallId: 't1',
        tool: 'propose_swap',
        system: 'occ',
        tier: 'propose',
        args: {},
      }),
      ev('agent.proposal', 10, {
        approvalId: 'a1',
        toolCallId: 't1',
        tool: 'propose_swap',
        args: {},
        summary: '',
        reasoning: '',
      }),
      ev('approval.decision', 12, {
        approvalId: 'a1',
        decision: 'approve',
        decidedBy: { kind: 'policy', policy: 'eval-auto' },
      }),
      ev('agent.tool_result', 12, { toolCallId: 't1', tool: 'propose_swap', ok: true, resultPreview: '' }),
      ev('agent.tool_call', 20, {
        toolCallId: 't2',
        tool: 'rebook_cohort',
        system: 'pss',
        tier: 'propose',
        args: {},
      }),
      ev('agent.tool_result', 20, { toolCallId: 't2', tool: 'rebook_cohort', ok: true, resultPreview: '' }),
    ];
    const k = computeKpis(snap(emptySystemState(), 30), P, events);
    expect(k.safety.value).toEqual({
      forbiddenAttempts: 2,
      humanDecisionsBeforeDependentActions: 1,
      dependentActionsWithoutDecision: 1,
    });
  });

  it('coordination latencies from the trigger', () => {
    const st = emptySystemState();
    st.pss.messages.m1 = {
      id: 'm1',
      cohortIds: [],
      channel: 'sms',
      body: 'x',
      status: 'sent',
      aiDrafted: true,
      sentAtMinute: 12,
    };
    const events = [
      ev('system.mutation', 20, {
        system: 'mne',
        entity: 'decisions',
        id: 'd',
        op: 'create',
        after: { id: 'd' },
      }),
      ev('system.mutation', 30, {
        system: 'occ',
        entity: 'swaps',
        id: 's',
        op: 'create',
        after: { status: 'proposed' },
      }),
      ev('system.mutation', 40, {
        system: 'occ',
        entity: 'swaps',
        id: 's',
        op: 'update',
        after: { status: 'approved' },
      }),
    ];
    const k = computeKpis(snap(st, 60), P, events);
    expect(k.latency.value).toEqual({
      firstEngineeringDecisionMin: 18,
      firstPaxMessageMin: 10,
      swapOrCancelDecisionMin: 38,
    });
    expect(computeKpis(snap(emptySystemState(), 60), P, []).latency.value).toEqual({
      firstEngineeringDecisionMin: null,
      firstPaxMessageMin: null,
      swapOrCancelDecisionMin: null,
    });
  });

  it('every KPI carries formula, inputs and contributing seqs', () => {
    const k = computeKpis(snap(emptySystemState(), 10), P, []);
    for (const key of [
      'delayCostEur',
      'eu261ExposureEur',
      'cancellationCostEur',
      'totalCostEur',
      'satisfaction',
      'compliance',
      'safety',
      'latency',
    ] as const) {
      expect(k[key].formula.length).toBeGreaterThan(10);
      expect(k[key].inputs).toBeTypeOf('object');
      expect(Array.isArray(k[key].contributingSeqs)).toBe(true);
    }
  });
});
