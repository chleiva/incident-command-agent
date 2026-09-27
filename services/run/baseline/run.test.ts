/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import { foldEvents, validateEvent, type Scenario } from '@ica/schema';
import { MINIMAL, makeHarness, ofType } from '../runtime/__fixtures__/harness';

describe('baseline mode', () => {
  it('replays the minimal fixture chronology end to end with no LLM', async () => {
    const h = await makeHarness({ mode: 'baseline', providers: {} });
    const r = await h.run();
    const events = await h.events();
    expect(r.status).toBe('completed');
    expect(r.reason).toBe('report');
    for (const e of events) expect(validateEvent(e).ok).toBe(true);
    expect(ofType(events, 'agent.thought')).toHaveLength(0);
    expect(ofType(events, 'run.created')[0].payload.config.provider).toBe('none');
    const actions = ofType(events, 'baseline.action');
    expect(actions.map((a) => [a.payload.tool, Math.floor(a.simMinute)])).toEqual([
      ['page_engineer', 10],
      ['send_passenger_message', 30],
      ['propose_swap', 40],
    ]);
    for (const e of ofType(events, 'agent.tool_call')) {
      expect(e.agentRunId).toBe('baseline');
      expect(e.actor.kind).toBe('human');
    }
    const decisions = ofType(events, 'approval.decision');
    expect(decisions).toHaveLength(2);
    expect(
      decisions.every(
        (d) => d.payload.decidedBy.kind === 'policy' && d.payload.decidedBy.policy === 'baseline',
      ),
    ).toBe(true);
    const p = foldEvents(events);
    expect(p.baselineActions).toBe(3);
    expect(p.kpis!.latency.value.firstPaxMessageMin).toBe(28); // sent at minute 30, trigger at 2
    expect(Object.values(p.systems.occ.swaps)[0]).toMatchObject({ status: 'approved' });
    expect(Math.round(p.simMinute)).toBe(55); // last action at 40 + 15 min grace
    expect(r.totals!.costUsd).toBe(0);
  });

  it('humans may run forbidden-tier tools; the system still enforces who may', async () => {
    const scenario: Scenario = {
      ...MINIMAL,
      baseline: [
        {
          atMinute: 5,
          actor: 'OCC controller',
          action: { tool: 'defer_defect', args: { defectId: 'd-1', melItem: '52-1' } },
          note: 'not allowed',
        },
        {
          atMinute: 6,
          actor: 'Certifying engineer (B1)',
          action: { tool: 'defer_defect', args: { defectId: 'd-1', melItem: '52-1' } },
          note: 'allowed',
        },
      ],
    };
    const h = await makeHarness({ mode: 'baseline', scenario, providers: {} });
    await h.run();
    const events = await h.events();
    const results = ofType(events, 'agent.tool_result');
    expect(results.map((r) => r.payload.ok)).toEqual([false, true]);
    expect(ofType(events, 'guardrail.blocked')).toHaveLength(0);
    expect(foldEvents(events).systems.mne.defects['d-1'].status).toBe('deferred');
  });

  it('a scripted reject in the chronology is honoured', async () => {
    const scenario: Scenario = {
      ...MINIMAL,
      baseline: [
        {
          atMinute: 3,
          actor: 'Passenger services',
          action: {
            tool: 'send_passenger_message',
            args: { cohortIds: ['c-general'], channel: 'sms', body: 'Delay update.' },
            decision: 'reject',
          },
          note: 'held back',
        },
      ],
    };
    const h = await makeHarness({ mode: 'baseline', scenario, providers: {} });
    await h.run();
    const events = await h.events();
    expect(ofType(events, 'approval.decision')[0].payload.decision).toBe('reject');
    expect(Object.keys(foldEvents(events).systems.pss.messages)).toHaveLength(0);
  });
});
