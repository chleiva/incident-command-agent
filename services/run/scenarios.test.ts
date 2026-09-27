/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * The ten shipped scenarios against the real systems and tools (no agent loop, no LLM): each seeds cleanly, every
 * baseline step is a valid call that succeeds through the same handlers the agents use, and key scenario properties
 * (options case, FDP squeeze, twist targets) hold.
 */
import { describe, expect, it } from 'vitest';
import { publicScenarios } from '@ica/scenarios';
import { SCENARIO_IDS, type Actor, type Scenario } from '@ica/schema';
import { computeFdp } from './systems/crew/index';
import { knownRefs } from './systems/index';
import { applyMutations } from './systems/util';
import { argsValid, call, fixtureHarness, withClientRequestId } from './tools/_testing';
import { toolByName } from './tools/index';

const byId = (id: string) => publicScenarios.find((s) => s.id === id) as Scenario;

describe('shipped scenarios', () => {
  it('ships exactly the ten fixed ids', () => {
    expect(publicScenarios.map((s) => s.id).sort()).toEqual([...SCENARIO_IDS].sort());
  });

  for (const id of SCENARIO_IDS) {
    it(`${id}: fictional carrier data, twists, and a baseline that runs through the real tools`, async () => {
      const s = byId(id);
      expect(s.narrative).toMatch(/Northwind|NW-/);
      expect(s.twists.some((t) => t.atMinute !== undefined)).toBe(true);
      expect(s.twists.some((t) => t.atMinute === undefined)).toBe(true);
      expect(s.world.cohorts.length).toBeGreaterThanOrEqual(3);
      expect(s.world.cohorts.length).toBeLessThanOrEqual(6);
      expect(s.world.cohorts.some((c) => c.kind === 'prm')).toBe(true);
      expect(s.world.cohorts.some((c) => c.kind === 'connections')).toBe(true);
      expect(s.expected.forbiddenTools).toEqual(
        expect.arrayContaining(['defer_defect', 'release_aircraft', 'extend_crew_fdp']),
      );
      for (const r of s.inspiredBy) expect(r.sourceId).toMatch(/^(ASRS ACN \d+|AAIB .+)$/);

      const h = await fixtureHarness(structuredClone(s));
      const refs = knownRefs(h.state);
      // twist patch targets exist (at seed, or created by an earlier twist)
      const created = new Set<string>();
      for (const tw of [...s.twists].sort((a, b) => (a.atMinute ?? 1e9) - (b.atMinute ?? 1e9)))
        for (const e of tw.effects) {
          if (e.op === 'create') created.add(String(e.record.id));
          if (e.op === 'patch')
            expect(
              (h.state as any)[e.system][e.entity][e.id] ?? (created.has(e.id) || undefined),
              `${tw.id} → ${e.id}`,
            ).toBeDefined();
          if (e.op === 'delay') expect(refs.flight).toContain(e.flight);
        }
      // baseline: human actors, same tool names, valid args, all succeed in order
      for (const step of [...s.baseline].sort((a, b) => a.atMinute - b.atMinute)) {
        h.advanceTo(step.atMinute);
        const tool = toolByName[step.action.tool];
        expect(tool, step.action.tool).toBeDefined();
        // The baseline's human "client" adds a requestId to idempotent calls (baseline/run.ts withRequestId).
        expect(
          argsValid(step.action.tool, withClientRequestId(step.action.tool, step.action.args)).errors ?? [],
        ).toEqual([]);
        expect(tool.tier).not.toBe('forbidden');
        if (tool.tier === 'propose') expect(step.action.decision).toBe('approve');
        const actor: Actor = { kind: 'human', name: step.actor, roleTitle: step.actor };
        const out = await call(h, step.action.tool, step.action.args, { actor, role: tool.roles[0] });
        expect(out.ok ? 'ok' : `${step.action.tool}: ${out.error}`).toBe('ok');
      }
      h.advanceTo(180);
    });
  }

  it('s04 is an options case: no spare and no licensed B1 at FAO', () => {
    const s = byId('s04-lightning-strike-outstation');
    expect(s.world.spares.some((x) => x.station === 'FAO')).toBe(false);
    expect(s.world.engineers.some((e) => e.station === 'FAO')).toBe(false);
  });

  it('s10: a delay of about 2.5 h breaks the crew FDP (squeeze)', async () => {
    const h = await fixtureHarness(structuredClone(byId('s10-brake-overheat-fdp-squeeze')));
    const cpt = h.state.crew.crew['crew-741-cpt'];
    const now = computeFdp(h.state, cpt, 0);
    expect(now.remainingMin).toBeGreaterThan(120);
    expect(now.remainingMin).toBeLessThan(200);
    const { retimeFlight } = await import('./systems/occ/index');
    const later = applyMutations(h.state, retimeFlight(h.state, 'NWD741', 50 + 150));
    expect(computeFdp(later, cpt, 60).remainingMin).toBeLessThan(0);
  });

  it('s06: the MEL search finds the APU item (fixture corpus)', async () => {
    const h = await fixtureHarness(structuredClone(byId('s06-apu-inop-deferral-temptation')));
    const out = await call(h, 'search_mel', { query: 'APU inoperative' });
    expect(out.ok && out.citations![0].chunkId).toBe('mmel-49-10-01#1');
  });
});
