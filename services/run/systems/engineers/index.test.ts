/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import { seededRng } from '../names';
import { fixtureScenario, harness } from '../testing';
import { applyMutations } from '../util';
import { pageEngineer, travelPlan } from './index';

describe('engineers travel rules', () => {
  it('same airport: walk 5–15 min', () => {
    const rng = seededRng(1);
    for (let i = 0; i < 20; i++) {
      const p = travelPlan(undefined, 'MAN', 'MAN', 10, rng);
      expect(p.mode).toBe('walk');
      expect(p.etaMinute - 10).toBeGreaterThanOrEqual(5);
      expect(p.etaMinute - 10).toBeLessThanOrEqual(15);
    }
  });

  it('drive at 60 km/h + 20 min when it is faster and there is a road', () => {
    const p = travelPlan(undefined, 'MAN', 'LBA', 0, seededRng(1));
    expect(p.mode).toBe('drive');
    expect(p.etaMinute).toBe(Math.round(p.distanceKm + 20));
  });

  it('fly (next positioning flight + block + 45) to islands and across seas', () => {
    const p = travelPlan(undefined, 'MAN', 'PMI', 0, seededRng(1));
    expect(p.mode).toBe('fly');
    const d = travelPlan(undefined, 'MAN', 'DUB', 0, seededRng(1));
    expect(d.mode).toBe('fly');
    const block = Math.round((d.distanceKm / 780) * 60 + 25);
    expect(d.etaMinute).toBeGreaterThanOrEqual(60 + block + 45);
    expect(d.etaMinute).toBeLessThanOrEqual(155 + block + 45);
  });

  it('uses a Northwind rotation leg as the positioning flight when one departs ≥ 45 min out', () => {
    const s = fixtureScenario();
    s.world.rotation.push({
      flight: 'NWD105',
      tail: 'NW-FXB',
      from: 'MAN',
      to: 'DUB',
      std: '2026-06-12T08:00:00Z',
      sta: '2026-06-12T09:00:00Z',
      pax: 150,
    });
    const h = harness(s);
    // NWD101 leaves at minute 40 (< now + 45), so the next one is NWD105 (arrives 210).
    const p = travelPlan(h.scenario, 'MAN', 'DUB', 0, h.rng);
    expect(p).toMatchObject({ mode: 'fly', etaMinute: 210 + 45 });
    expect(p.detail).toMatch(/NWD105/);
  });
});

describe('engineers paging lifecycle', () => {
  it('paged → travelling → on_site at the ETA', () => {
    const h = harness();
    const r = pageEngineer(h.state, h.scenario, { engineerId: 'eng-1', station: 'MAN' }, 0, h.rng);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    h.state = applyMutations(h.state, r.mutations);
    expect(h.state.engineers.engineers['eng-1']).toMatchObject({
      status: 'paged',
      travelMode: 'walk',
      destination: 'MAN',
    });
    h.advanceTo(1);
    expect(h.state.engineers.engineers['eng-1'].status).toBe('travelling');
    h.advanceTo(r.value.plan.etaMinute);
    expect(h.state.engineers.engineers['eng-1']).toMatchObject({ status: 'on_site', location: 'MAN' });
  });

  it('busy engineers cannot be paged until available; they free up at availableFromMinute', () => {
    const h = harness();
    expect(h.state.engineers.engineers['eng-2']).toMatchObject({ status: 'busy', availableFromMinute: 20 });
    expect(
      pageEngineer(h.state, h.scenario, { engineerId: 'eng-2', station: 'MAN' }, 0, h.rng),
    ).toMatchObject({
      ok: false,
      error: expect.stringMatching(/busy until minute 20/),
    });
    h.advanceTo(20);
    expect(h.state.engineers.engineers['eng-2'].status).toBe('available');
  });
});
