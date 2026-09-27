/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import type { Scenario } from '@ica/schema';
import { DUTY_MANAGER, fixtureScenario, harness } from '../testing';
import { applyMutations } from '../util';
import {
  compatibleType,
  curfewConflict,
  downstreamOfCancel,
  executeCancel,
  executeSwap,
  planSwap,
  retimeFlight,
  tickOcc,
} from './index';

function withThirdLeg(): Scenario {
  const s = fixtureScenario();
  s.world.rotation.push({
    flight: 'ACX103',
    tail: 'AX-FXA',
    from: 'MAN',
    to: 'AGP',
    std: '2026-06-12T09:40:00Z',
    sta: '2026-06-12T12:10:00Z',
    pax: 170,
  });
  return s;
}

describe('occ seed', () => {
  it('seeds flights with sim-minute STD/STA, spares and curfews', () => {
    const { state } = harness();
    expect(state.occ.flights.ACX101).toMatchObject({
      tail: 'AX-FXA',
      stdMinute: 40,
      staMinute: 100,
      status: 'scheduled',
    });
    expect(state.occ.spares['AX-FXB']).toMatchObject({ station: 'MAN', availableFromMinute: 45 });
  });
});

describe('occ swap rules', () => {
  it('type compatibility: same family and enough seats', () => {
    expect(compatibleType('A321', 'A320', 180)).toBe(true);
    expect(compatibleType('A319', 'A320', 170)).toBe(false);
    expect(compatibleType('E190', 'A320', 90)).toBe(false);
  });

  it('re-times the swap to spare availability + 35 min when the spare is not ready by STD − 35', () => {
    const h = harness();
    const plan = planSwap(
      h.state,
      { fromTail: 'AX-FXA', toTail: 'AX-FXB', flights: ['ACX101', 'ACX102'] },
      0,
    );
    expect(plan.ok && plan.value).toMatchObject({ onTime: false, departureMinute: 80, delayMin: 40 });
  });

  it('is on time when the spare is available by STD − 35', () => {
    const s = fixtureScenario();
    s.world.spares[0].availableFromMinute = 0;
    const h = harness(s);
    const plan = planSwap(h.state, { fromTail: 'AX-FXA', toTail: 'AX-FXB', flights: ['ACX101'] }, 0);
    expect(plan.ok && plan.value).toMatchObject({ onTime: true, departureMinute: 40, delayMin: 0 });
  });

  it('executes: re-tails flights, delays them, propagates, assigns the spare and records the approver', () => {
    const h = harness();
    const r = executeSwap(
      h.state,
      { fromTail: 'AX-FXA', toTail: 'AX-FXB', flights: ['ACX101', 'ACX102'] },
      0,
      DUTY_MANAGER,
      h.rng,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const s = applyMutations(h.state, r.mutations);
    expect(s.occ.flights.ACX101).toMatchObject({
      tail: 'AX-FXB',
      status: 'swapped',
      delayMin: 40,
      etd: '2026-06-12T06:50:00Z',
    });
    // ACX101 arrives at 140; next earliest 175 vs STD 135 → 40 min reactionary
    expect(s.occ.flights.ACX102).toMatchObject({ tail: 'AX-FXB', delayMin: 40, reactionaryDelayMin: 40 });
    expect(s.occ.spares['AX-FXB'].assignedTo).toBe('ACX101,ACX102');
    expect(Object.values(s.occ.swaps)[0]).toMatchObject({ status: 'executed', approvedBy: DUTY_MANAGER });
    // the spare can't be used twice
    expect(planSwap(s, { fromTail: 'AX-FXA', toTail: 'AX-FXB', flights: ['ACX101'] }, 0).ok).toBe(false);
  });

  it('rejects a spare at another station, of an incompatible type, or flights of another tail', () => {
    const s1 = fixtureScenario();
    s1.world.spares[0].station = 'DUB';
    expect(
      planSwap(harness(s1).state, { fromTail: 'AX-FXA', toTail: 'AX-FXB', flights: ['ACX101'] }, 0),
    ).toMatchObject({
      ok: false,
      error: expect.stringMatching(/is at DUB/),
    });
    const s2 = fixtureScenario();
    s2.world.spares[0].type = 'E190';
    expect(
      planSwap(harness(s2).state, { fromTail: 'AX-FXA', toTail: 'AX-FXB', flights: ['ACX101'] }, 0).ok,
    ).toBe(false);
    const h = harness();
    expect(planSwap(h.state, { fromTail: 'AX-FXB', toTail: 'AX-FXB', flights: ['ACX101'] }, 0).ok).toBe(
      false,
    );
    expect(planSwap(h.state, { fromTail: 'AX-FXA', toTail: 'AX-FXA', flights: ['ACX101'] }, 0).ok).toBe(
      false,
    );
  });
});

describe('occ cancellation', () => {
  it('cancels downstream legs until the rotation returns to where the aircraft is', () => {
    const h = harness(withThirdLeg());
    expect(downstreamOfCancel(h.state, 'ACX101')).toEqual(['ACX102']);
    const r = executeCancel(h.state, 'ACX101', DUTY_MANAGER, h.rng);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const s = applyMutations(h.state, r.mutations);
    expect(s.occ.flights.ACX101.status).toBe('cancelled');
    expect(s.occ.flights.ACX102.status).toBe('cancelled');
    expect(s.occ.flights.ACX103.status).toBe('scheduled');
    expect(Object.values(s.occ.cancellations)[0]).toMatchObject({
      flight: 'ACX101',
      approvedBy: DUTY_MANAGER,
    });
    expect(executeCancel(s, 'ACX101', DUTY_MANAGER, h.rng).ok).toBe(false);
  });
});

describe('occ reactionary delay', () => {
  it('slips the next STD by the arrival delay minus the buffer (ground time − 35)', () => {
    const s = fixtureScenario();
    s.world.rotation[1].std = '2026-06-12T07:55:00Z'; // ground time 45 → buffer 10
    const h = harness(s);
    const ms = retimeFlight(h.state, 'ACX101', 60); // 20 min late
    const next = applyMutations(h.state, ms);
    expect(next.occ.flights.ACX101).toMatchObject({ delayMin: 20, status: 'delayed' });
    expect(next.occ.flights.ACX102).toMatchObject({ delayMin: 10, reactionaryDelayMin: 10 });
  });

  it('no slip when the buffer absorbs the delay', () => {
    const s = fixtureScenario();
    s.world.rotation[1].std = '2026-06-12T08:30:00Z'; // ground time 80 → buffer 45
    const h = harness(s);
    const next = applyMutations(h.state, retimeFlight(h.state, 'ACX101', 70));
    expect(next.occ.flights.ACX102.delayMin).toBe(0);
  });
});

describe('occ curfew and tick', () => {
  it('blocks an ETD inside the origin curfew', () => {
    const s = fixtureScenario();
    s.world.curfews = [{ station: 'MAN', fromLocal: '07:00', toLocal: '08:00' }]; // 06:00–07:00Z (BST)
    const h = harness(s);
    const f = h.state.occ.flights.ACX101;
    expect(curfewConflict(h.state, f, 45)).toMatch(/inside the MAN curfew/);
    expect(curfewConflict(h.state, f, 20)).toBeUndefined();
    expect(curfewConflict(h.state, f, 95)).toBeUndefined();
    // swap into the curfew is refused
    expect(planSwap(h.state, { fromTail: 'AX-FXA', toTail: 'AX-FXB', flights: ['ACX101'] }, 0)).toMatchObject(
      {
        ok: false,
        error: expect.stringMatching(/curfew/),
      },
    );
    // a slipping ETD is pushed past the curfew
    const ms = tickOcc(h.state, 25, 1);
    const next = applyMutations(h.state, ms);
    expect(next.occ.flights.ACX101.delayMin).toBe(50); // ETD 90 = 07:00Z
  });

  it('slips the next flight while the tail is unserviceable, and departs it once released', () => {
    const h = harness();
    h.advanceTo(25);
    expect(h.state.occ.flights.ACX101).toMatchObject({ status: 'delayed', delayMin: 5 });
    h.advanceTo(40);
    expect(h.state.occ.flights.ACX101.delayMin).toBe(20);
    const ac = h.state.mne.aircraft['AX-FXA'];
    h.state = applyMutations(h.state, [
      { system: 'mne', entity: 'aircraft', id: ac.tail, op: 'update', after: { ...ac, status: 'released' } },
    ]);
    h.advanceTo(60);
    expect(h.state.occ.flights.ACX101.status).toBe('departed');
    expect(h.state.occ.flights.ACX102).toMatchObject({ status: 'delayed', reactionaryDelayMin: 20 });
  });
});
