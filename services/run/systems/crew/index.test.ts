/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import { fixtureScenario, harness } from '../testing';
import { applyMutations } from '../util';
import { retimeFlight } from '../occ/index';
import { assignStandby, computeFdp, pairing, requestFdpExtension, tickCrew } from './index';

describe('crew FDP arithmetic', () => {
  it('seeds operating crew on the tail rotation with used and remaining FDP', () => {
    const { state } = harness();
    const cpt = state.crew.crew['crew-cpt-1'];
    expect(cpt).toMatchObject({ status: 'operating', assignedFlight: 'ACX101' });
    expect(pairing(state, cpt).map((f) => f.flight)).toEqual(['ACX101', 'ACX102']);
    // reported at −20; last on-blocks at 200 → 660 − 20 − 200 = 440
    expect(cpt).toMatchObject({ fdpUsedMin: 20, fdpRemainingMin: 440 });
    expect(state.crew.crew['crew-cpt-sby']).toMatchObject({
      status: 'standby',
      fdpUsedMin: 0,
      fdpRemainingMin: 720,
    });
  });

  it('used grows with time; delays eat the remaining margin', () => {
    const h = harness();
    const cpt = h.state.crew.crew['crew-cpt-1'];
    expect(computeFdp(h.state, cpt, 60)).toMatchObject({
      usedMin: 80,
      remainingPlannedMin: 140,
      remainingMin: 440,
    });
    const delayed = applyMutations(h.state, retimeFlight(h.state, 'ACX101', 70)); // 30 min late, propagates
    expect(computeFdp(delayed, cpt, 60)).toMatchObject({ usedMin: 80, remainingMin: 410 });
    const ms = tickCrew(delayed, 60, 1);
    expect(ms.length).toBe(2);
    expect(ms[0].after).toMatchObject({ fdpUsedMin: 80, fdpRemainingMin: 410 });
    // no churn: nothing to persist a minute later
    expect(tickCrew(applyMutations(delayed, ms), 61, 1)).toEqual([]);
  });

  it('refuses any extension beyond the maximum FDP', () => {
    const { state } = harness();
    const r = requestFdpExtension(state, 'crew-cpt-1', 30);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/cannot be exceeded by software/);
  });
});

describe('crew standby assignment', () => {
  it('assigns a standby of matching rank with enough FDP', () => {
    const h = harness();
    const r = assignStandby(
      h.state,
      { standbyId: 'crew-cpt-sby', replacesCrewId: 'crew-cpt-1', flight: 'ACX101' },
      10,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.requiredFdpMin).toBe(190);
    const s = applyMutations(h.state, r.mutations);
    expect(s.crew.crew['crew-cpt-sby']).toMatchObject({
      status: 'assigned',
      assignedFlight: 'ACX101',
      sectorsPlanned: 2,
    });
    expect(s.crew.crew['crew-cpt-1'].status).toBe('off');
  });

  it('rejects rank mismatch, wrong station and insufficient FDP', () => {
    const h = harness();
    expect(
      assignStandby(
        h.state,
        { standbyId: 'crew-cpt-sby', replacesCrewId: 'crew-fo-1', flight: 'ACX101' },
        10,
      ),
    ).toMatchObject({
      ok: false,
      error: expect.stringMatching(/rank mismatch/),
    });
    expect(
      assignStandby(
        h.state,
        { standbyId: 'crew-cpt-sby', replacesCrewId: 'crew-cpt-1', flight: 'ACX102' },
        10,
      ),
    ).toMatchObject({
      ok: false,
      error: expect.stringMatching(/departs DUB/),
    });
    const s = fixtureScenario();
    s.world.crew[2].maxFdpMin = 120;
    const h2 = harness(s);
    expect(
      assignStandby(
        h2.state,
        { standbyId: 'crew-cpt-sby', replacesCrewId: 'crew-cpt-1', flight: 'ACX101' },
        10,
      ),
    ).toMatchObject({
      ok: false,
      error: expect.stringMatching(/lacks FDP/),
    });
  });
});
