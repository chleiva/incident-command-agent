/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Flight-context scenarios (task 07, `@ica/network/templates`) against the real systems and tools: for each ground
 * and airborne incident type, scenarios built from live-network flights seed cleanly and their baseline chronology
 * runs through the same handlers the agents use (no agent loop, no LLM).
 */
import { flightTimes, generateDaySchedule } from '@ica/network';
import { buildScenarioFromFlight, incidentContext, incidentTypesFor } from '@ica/network/templates';
import type { Actor, Scenario } from '@ica/schema';
import { describe, expect, it } from 'vitest';
import { knownRefs } from './systems/index';
import { argsValid, call, fixtureHarness, withClientRequestId } from './tools/_testing';
import { toolByName } from './tools/index';

const schedule = generateDaySchedule('accent-air', '2026-09-27');

/** Up to `n` built scenarios per incident type, from different flights and phases. */
function samples(n: number): Map<string, Scenario[]> {
  const out = new Map<string, Scenario[]>();
  for (const f of schedule.flights) {
    const t = flightTimes(f);
    for (const at of [
      t.offBlockMs - 20 * 60_000,
      t.offBlockMs + 5 * 60_000,
      t.inBlockMs + 15 * 60_000,
      t.takeoffMs + 6 * 60_000,
      (t.takeoffMs + t.landingMs) / 2,
    ]) {
      for (const o of incidentTypesFor(incidentContext(schedule, f.flight, at)!).filter((x) => x.enabled)) {
        const list = out.get(o.type.id) ?? [];
        if (list.length >= n || list.some((s) => s.aircraft.tail === f.tail)) continue;
        list.push(buildScenarioFromFlight(schedule, f.flight, o.type.id, { atMs: at }).scenario);
        out.set(o.type.id, list);
      }
    }
  }
  return out;
}

describe('flight-context scenarios run through the real tools', () => {
  const byType = samples(2);
  it('covers every ground and airborne incident type', () => {
    expect(byType.size).toBe(15);
  });
  for (const [type, list] of byType)
    for (const s of list)
      it(`${type} on ${s.airborne?.flight ?? s.aircraft.nextSectors[0]!.flight} at ${s.aircraft.station}: seeds and runs its baseline`, async () => {
        const h = await fixtureHarness(structuredClone(s));
        const refs = knownRefs(h.state);
        for (const tw of s.twists)
          for (const e of tw.effects) if (e.op === 'delay') expect(refs.flight).toContain(e.flight);
        for (const step of [...s.baseline].sort((a, b) => a.atMinute - b.atMinute)) {
          h.advanceTo(step.atMinute);
          const tool = toolByName[step.action.tool]!;
          expect(
            argsValid(step.action.tool, withClientRequestId(step.action.tool, step.action.args)).errors ?? [],
          ).toEqual([]);
          const actor: Actor = { kind: 'human', name: step.actor, roleTitle: step.actor };
          const out = await call(h, step.action.tool, step.action.args, { actor, role: tool.roles[0] });
          expect(out.ok ? 'ok' : `${step.action.tool}: ${out.error}`).toBe('ok');
        }
        h.advanceTo(180);
      });
});
