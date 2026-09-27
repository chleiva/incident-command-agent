/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import type { Actor } from '@ica/schema';
import { CERTIFYING, DUTY_MANAGER, harness } from '../testing';
import { applyMutations } from '../util';
import {
  createWorkOrder,
  deferDefect,
  melRefsFromText,
  recordEngineeringDecision,
  releaseAircraft,
  tickMne,
} from './index';

const AGENT: Actor = { kind: 'agent', role: 'maintenance' };

describe('mne seed', () => {
  it('seeds the aircraft (unserviceable), spares (serviceable) and an open defect from the trigger', () => {
    const h = harness();
    expect(h.state.mne.aircraft['AX-FXA']).toMatchObject({
      status: 'unserviceable',
      station: 'MAN',
      stand: '22',
    });
    expect(h.state.mne.aircraft['AX-FXB'].status).toBe('serviceable');
    const defects = Object.values(h.state.mne.defects);
    expect(defects).toHaveLength(1);
    expect(defects[0]).toMatchObject({ tail: 'AX-FXA', status: 'open', raisedAtMinute: 2 });
  });

  it('extracts MEL references quoted in evidence', () => {
    expect(melRefsFromText('Per MEL 49-10-01 the APU may be inop; see also MEL item 21-31-02.')).toEqual([
      '49-10-01',
      '21-31-02',
    ]);
  });
});

describe('mne authority rules', () => {
  it('refuses deferral by an agent, a policy or a non-certifying human', () => {
    const { state } = harness();
    for (const actor of [AGENT, DUTY_MANAGER, { kind: 'policy', policy: 'eval-auto' } as Actor]) {
      const r = deferDefect(state, 'DEF-001', '52-10-01', actor);
      expect(r.ok).toBe(false);
    }
  });

  it('lets a certifying human defer; the aircraft becomes serviceable', () => {
    const { state } = harness();
    const r = deferDefect(state, 'DEF-001', '52-10-01', CERTIFYING);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const next = applyMutations(state, r.mutations);
    expect(next.mne.defects['DEF-001']).toMatchObject({
      status: 'deferred',
      melItem: '52-10-01',
      deferredBy: CERTIFYING,
    });
    expect(next.mne.aircraft['AX-FXA'].status).toBe('serviceable');
    // every mutation carries the FULL entity
    for (const m of r.mutations) expect(m.after).toHaveProperty(m.entity === 'aircraft' ? 'tail' : 'id');
  });

  it('refuses release by non-certifying actors and while a defect has no finished work order', () => {
    const { state } = harness();
    expect(releaseAircraft(state, 'AX-FXA', AGENT).ok).toBe(false);
    expect(releaseAircraft(state, 'AX-FXA', DUTY_MANAGER).ok).toBe(false);
    const r = releaseAircraft(state, 'AX-FXA', CERTIFYING);
    expect(r.ok ? '' : r.error).toMatch(/still open/);
  });

  it('engineering decisions need a named human; defer_mel needs a certifying one', () => {
    const h = harness();
    expect(
      recordEngineeringDecision(h.state, { tail: 'AX-FXA', decision: 'aog' }, AGENT, 'x', 5, h.rng).ok,
    ).toBe(false);
    const d1 = recordEngineeringDecision(
      h.state,
      { tail: 'AX-FXA', decision: 'defer_mel', melItem: '52-10-01' },
      DUTY_MANAGER,
      'x',
      5,
      h.rng,
    );
    expect(d1.ok).toBe(false);
    const d2 = recordEngineeringDecision(
      h.state,
      { tail: 'AX-FXA', decision: 'aog' },
      DUTY_MANAGER,
      'awaiting parts',
      5,
      h.rng,
    );
    expect(d2.ok).toBe(true);
    if (d2.ok) {
      const next = applyMutations(h.state, d2.mutations);
      expect(next.mne.aircraft['AX-FXA'].status).toBe('aog');
      expect(Object.values(next.mne.decisions)[0]).toMatchObject({
        decision: 'aog',
        decidedBy: DUTY_MANAGER,
      });
    }
  });
});

describe('mne work-order lifecycle', () => {
  it('created → assigned → in_progress (engineer on site) → awaiting_certification → closed on release', () => {
    const h = harness();
    const r = createWorkOrder(
      h.state,
      { tail: 'AX-FXA', defectId: 'DEF-001', task: 'Inspect door sensor', estimatedDurationMin: 30 },
      0,
      h.rng,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    h.state = applyMutations(h.state, r.mutations);
    const id = r.value.id;
    expect(h.state.mne.workOrders[id].status).toBe('created');
    // assign eng-1 (at MAN) and page it to MAN: it walks, then arrives on site.
    const wo = h.state.mne.workOrders[id];
    h.state = applyMutations(h.state, [
      {
        system: 'mne',
        entity: 'workOrders',
        id,
        op: 'update',
        after: { ...wo, assignedEngineerId: 'eng-1' },
      },
    ]);
    h.advanceTo(1);
    expect(h.state.mne.workOrders[id].status).toBe('assigned');
    const e = h.state.engineers.engineers['eng-1'];
    h.state = applyMutations(h.state, [
      {
        system: 'engineers',
        entity: 'engineers',
        id: 'eng-1',
        op: 'update',
        after: { ...e, status: 'on_site', location: 'MAN' },
      },
    ]);
    h.advanceTo(2);
    expect(h.state.mne.workOrders[id]).toMatchObject({ status: 'in_progress', startedAtMinute: 2 });
    h.advanceTo(17);
    expect(h.state.mne.workOrders[id].progressPct).toBe(50);
    h.advanceTo(32);
    expect(h.state.mne.workOrders[id]).toMatchObject({ status: 'awaiting_certification', progressPct: 100 });
    // nothing more happens without a human
    expect(tickMne(h.state, 60, 1)).toEqual([]);
    const rel = releaseAircraft(h.state, 'AX-FXA', CERTIFYING);
    expect(rel.ok).toBe(true);
    if (!rel.ok) return;
    h.state = applyMutations(h.state, rel.mutations);
    expect(h.state.mne.workOrders[id].status).toBe('closed');
    expect(h.state.mne.defects['DEF-001'].status).toBe('rectified');
    expect(h.state.mne.aircraft['AX-FXA'].status).toBe('released');
  });

  it('rejects work orders for unknown tails, defects on another tail and unknown engineers', () => {
    const h = harness();
    expect(
      createWorkOrder(h.state, { tail: 'AX-ZZZ', task: 't', estimatedDurationMin: 5 }, 0, h.rng).ok,
    ).toBe(false);
    expect(
      createWorkOrder(
        h.state,
        { tail: 'AX-FXB', defectId: 'DEF-001', task: 't', estimatedDurationMin: 5 },
        0,
        h.rng,
      ).ok,
    ).toBe(false);
    expect(
      createWorkOrder(
        h.state,
        { tail: 'AX-FXA', task: 't', estimatedDurationMin: 5, engineerId: 'nobody' },
        0,
        h.rng,
      ).ok,
    ).toBe(false);
  });
});
