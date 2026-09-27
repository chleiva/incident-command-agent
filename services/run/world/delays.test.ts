/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Integration: flight delays have ONE writer (the occ system's tick), and the KPIs count each delayed minute once
 * (`delayMin` is the total; `reactionaryDelayMin` is the reactionary share of it).
 */
import { describe, expect, it, vi } from 'vitest';
import { foldEvents, type Scenario } from '@ica/schema';
import { getPublicScenario } from '@ica/scenarios';
import { makeHarness } from '../runtime/__fixtures__/harness';
import { defaultRegistry } from '../runtime/registry';
import { tickOcc } from '../systems/occ/index';
import { seedAll } from '../systems/index';
import { applyMutations } from '../systems/util';
import { WorldEngine } from './engine';
import { computeKpis } from './kpi';
import { applyTwistEffects } from './twists';

const S01 = getPublicScenario('s01-pushback-tug-contact') as Scenario;

describe('flight delays: occ.tick is the single owner', () => {
  it('KPIs count reactionary minutes once (primary = delayMin − reactionary)', () => {
    let state = seedAll(S01, () => 0.5);
    state.mne.aircraft['NW-MAB'] = { ...state.mne.aircraft['NW-MAB'], status: 'unserviceable' };
    // Slip NWD211 by occ.tick until its ETD is well past the turn buffer so NWD212 inherits reactionary delay.
    for (let m = 0; m <= 180; m += 1) state = applyMutations(state, tickOcc(state, m, 1));
    const flights = Object.values(state.occ.flights).filter((f) => f.tail === 'NW-MAB');
    const reactionary = flights.filter((f) => f.reactionaryDelayMin > 0);
    expect(reactionary.length).toBeGreaterThan(0);
    for (const f of flights) expect(f.reactionaryDelayMin).toBeLessThanOrEqual(f.delayMin);

    const k = computeKpis({ simMinute: 180, triggerMinute: 0, state }, S01.kpiParams, []);
    const live = Object.values(state.occ.flights).filter((f) => f.status !== 'cancelled');
    const total = live.reduce((s, f) => s + f.delayMin, 0);
    const react = live.reduce((s, f) => s + f.reactionaryDelayMin, 0);
    expect(k.delayCostEur.inputs).toMatchObject({ primaryMin: total - react, reactionaryMin: react });
    expect(k.delayCostEur.value).toBeCloseTo(
      S01.kpiParams.eurPerMinute * (total - react + S01.kpiParams.reactionaryFactor * react),
      2,
    );
  });

  it('with the real registry the engine never writes flight delays itself', async () => {
    const spy = vi.spyOn(WorldEngine.prototype, 'flightDelayMutations');
    const h = await makeHarness({
      scenario: S01,
      registry: defaultRegistry(),
      mode: 'baseline',
      policy: 'baseline',
      limits: { horizonMin: 120 },
    });
    await h.run();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    const view = foldEvents(await h.events());
    for (const f of Object.values(view.systems.occ.flights))
      expect(f.reactionaryDelayMin).toBeLessThanOrEqual(f.delayMin);
  });

  it('a delay twist re-times the ETD and propagates reactionary delay like occ does', () => {
    const state = seedAll(S01, () => 0.5);
    const res = applyTwistEffects(state, [{ op: 'delay', flight: 'NWD211', minutes: 150 }]);
    expect(res.errors).toEqual([]);
    const after = applyMutations(state, res.mutations);
    expect(after.occ.flights.NWD211).toMatchObject({ delayMin: 150, status: 'delayed' });
    expect(after.occ.flights.NWD211.etd).toBeDefined();
    const next = after.occ.flights.NWD212;
    expect(next.reactionaryDelayMin).toBe(next.delayMin);
    expect(next.delayMin).toBeGreaterThan(0);
  });
});
