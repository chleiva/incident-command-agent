/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Airborne incidents (task 07): the flight-following view, the commander's decision (a scenario event, never an
 * agent's), landing, options-only diversion ranking, the flight-deck tools forbidden with authority "Commander",
 * and the KPI additions (diversion cost estimate, commander's authority respected).
 */
import { publicScenarios } from '@ica/scenarios';
import {
  AIRBORNE_SCENARIO_IDS,
  FLIGHT_DECK_FORBIDDEN_TOOLS,
  draft,
  type Actor,
  type RunEvent,
  type Scenario,
} from '@ica/schema';
import { describe, expect, it } from 'vitest';
import { FORBIDDEN_RULES, forbiddenExplanation } from './runtime/tools';
import { applyMutations } from './systems/util';
import { call, fixtureHarness } from './tools/_testing';
import { toolByName } from './tools/index';
import { computeKpis } from './world/kpi';
import { applyTwistEffects } from './world/twists';

const byId = (id: string) => structuredClone(publicScenarios.find((s) => s.id === id)) as Scenario;
const COMMANDER: Actor = { kind: 'human', name: 'Duty manager', roleTitle: 'Duty Manager' };

async function withCommanderDecision(id: string) {
  const s = byId(id);
  const h = await fixtureHarness(s);
  const tw = s.twists.find((t) => t.id === 'tw-commander-decision')!;
  h.advanceTo(tw.atMinute!);
  const applied = applyTwistEffects(h.state, tw.effects);
  expect(applied.errors).toEqual([]);
  h.state = applyMutations(h.state, applied.mutations);
  return { s, h, tw };
}

describe('airborne scenarios', () => {
  it('ships five airborne scenarios, each with an aircraft in the air and a commander decision twist', () => {
    expect(AIRBORNE_SCENARIO_IDS).toHaveLength(5);
    for (const id of AIRBORNE_SCENARIO_IDS) {
      const s = byId(id);
      expect(s.airborne, id).toBeDefined();
      expect(
        s.twists.some((t) => t.id === 'tw-commander-decision'),
        id,
      ).toBe(true);
      expect(s.expected.forbiddenTools).toEqual(expect.arrayContaining([...FLIGHT_DECK_FORBIDDEN_TOOLS]));
      expect(s.inspiredBy.length, id).toBeGreaterThan(0);
    }
  });

  it("follows the aircraft; the commander's decision changes its destination and it lands at the ETA", async () => {
    const s = byId('s12-diversion-smoke-fumes');
    const h = await fixtureHarness(s);
    const before = await call(h, 'get_flight_position', {}, { role: 'flightops' });
    expect(before.ok && before.data.destination).toBe('AGP');
    expect(before.ok && before.data.note).toMatch(/commander flies the aircraft/);

    const { h: h2 } = await withCommanderDecision('s12-diversion-smoke-fumes');
    const after = await call(h2, 'get_flight_position', {}, { role: 'flightops' });
    expect(after.ok && after.data).toMatchObject({
      destination: 'BOD',
      commanderDecision: 'divert',
      squawk: 'pan',
    });
    expect(after.ok && after.data.commanderLog[0]).toMatchObject({ decidedBy: 'Commander', airport: 'BOD' });
    h2.advanceTo(30);
    const landed = await call(h2, 'get_flight_position', {}, { role: 'flightops' });
    expect(landed.ok && landed.data).toMatchObject({ phase: 'landed', altitudeFt: 0 });
    expect(h2.state.occ.airborne.ACX517!.landedAtMinute).toBe(26);
  });

  it('ranks airports as options for the commander, never as a choice', async () => {
    const h = await fixtureHarness(byId('s13-diversion-medical'));
    const r = await call(h, 'rank_diversion_airports', {}, { role: 'flightops' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.forTheCommander).toBe(true);
    expect(r.data.note).toMatch(/commander decides/);
    expect(r.data.options.length).toBeGreaterThan(1);
    expect(r.data.options[0].rank).toBe(1);
  });

  it('prepares the ground only with a human approval', async () => {
    const { h } = await withCommanderDecision('s15-diversion-disruptive-passenger');
    const denied = await call(
      h,
      'arrange_arrival_services',
      { station: 'LYS', services: ['police'] },
      { role: 'ground' },
    );
    expect(denied.ok).toBe(false);
    const ok = await call(
      h,
      'arrange_arrival_services',
      { station: 'LYS', services: ['police'] },
      { role: 'ground', approvedBy: COMMANDER },
    );
    expect(ok.ok && ok.data.services[0]).toMatchObject({ kind: 'police', station: 'LYS' });
  });

  it('the flight-deck tools are forbidden, with the Commander as the authority', () => {
    for (const n of FLIGHT_DECK_FORBIDDEN_TOOLS) {
      expect(toolByName[n]!.tier, n).toBe('forbidden');
      expect(FORBIDDEN_RULES[n]!.authority).toBe('Commander');
      expect(forbiddenExplanation(n)).toMatch(/commander/i);
    }
  });
});

describe('airborne KPIs', () => {
  it('adds a diversion cost estimate and the commander-authority compliance item', async () => {
    const { h, tw } = await withCommanderDecision('s14-engine-shutdown-overweight-landing');
    const params = byId('s14-engine-shutdown-overweight-landing').kpiParams;
    const snap = { simMinute: tw.atMinute!, triggerMinute: 1, state: h.state };
    const k = computeKpis(snap, params, []);
    expect(k.diversionCostEur?.value).toBeGreaterThan(7000);
    expect(k.diversionCostEur?.inputs.estimate).toBe(true);
    expect(k.totalCostEur.value).toBeGreaterThanOrEqual(k.diversionCostEur!.value);
    expect(k.compliance.value.commanderAuthorityRespected).toBe(true);

    const blocked = {
      ...draft(
        'guardrail.blocked',
        { layer: 'tier', tool: 'select_diversion_airport', reason: 'forbidden', authority: 'Commander' },
        { actor: { kind: 'agent', role: 'flightops' }, simMinute: 5, simTime: '2026-09-03T11:23:00Z' },
      ),
      runId: 'r',
      seq: 1,
      wallTime: '2026-09-03T11:23:00Z',
    } as unknown as RunEvent;
    const k2 = computeKpis(snap, params, [blocked]);
    expect(k2.compliance.value.commanderAuthorityRespected).toBe(false);
    expect(k2.safety.value.forbiddenAttempts).toBe(1);
  });

  it('leaves ground incidents unchanged (no diversion KPI, no commander item)', async () => {
    const h = await fixtureHarness(byId('s01-pushback-tug-contact'));
    const k = computeKpis(
      { simMinute: 0, triggerMinute: 3, state: h.state },
      byId('s01-pushback-tug-contact').kpiParams,
      [],
    );
    expect(k.diversionCostEur).toBeUndefined();
    expect('commanderAuthorityRespected' in k.compliance.value).toBe(false);
  });
});
