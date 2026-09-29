/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import { validateScenario, type ScenarioPatch } from '@ica/schema';
import { describe, expect, it } from 'vitest';
import { generateDaySchedule } from '../schedule';
import { flightTimes } from '../state';
import {
  applyAuthoredPatch,
  buildNeutralScenarioFromFlight,
  isNeutralScenario,
  networkPatchErrors,
  networkSlice,
  regionFromText,
  scenarioFlightCount,
  TemplateError,
} from './index';

const schedule = generateDaySchedule('accent-air', '2026-09-27');
const ASH = 'UK decided to close air space, volcano eruption has covered european air with ashes';
/** Words of the templates' incidents that must never leak into a neutral base. */
const INCIDENT_WORDS =
  /fume|smell|acrid|smoke|\bPAN\b|bird|lightning|shear pin|catering|slide|hydraulic|fuel spill|brake|APU|medical|disruptive/i;

function midFlight() {
  const f = schedule.flights.find((x) => !x.cancelled && x.distanceKm > 1200 && x.from === 'MAN')!;
  const t = flightTimes(f);
  return { f, at: (t.takeoffMs + t.landingMs) / 2 };
}

describe('buildNeutralScenarioFromFlight ("Something else")', () => {
  it('builds a schema-valid base with no incident content, on the ground and in the air', () => {
    let n = 0;
    for (const f of schedule.flights.slice(0, 60)) {
      const t = flightTimes(f);
      for (const at of [
        t.offBlockMs - 20 * 60_000,
        (t.takeoffMs + t.landingMs) / 2,
        t.inBlockMs + 10 * 60_000,
      ]) {
        let b;
        try {
          b = buildNeutralScenarioFromFlight(schedule, f.flight, { atMs: at });
        } catch (e) {
          expect(e).toBeInstanceOf(TemplateError);
          continue;
        }
        n++;
        const s = b.scenario;
        const v = validateScenario(s);
        expect(v.ok ? [] : v.errors, `${f.flight}`).toEqual([]);
        expect(isNeutralScenario(s)).toBe(true);
        expect(s.twists).toEqual([]);
        expect(s.trigger.evidence).toEqual([]);
        expect(s.inspiredBy).toEqual([]);
        expect(s.title).toBe(`Reported incident: ${f.flight}`);
        expect(JSON.stringify(s)).not.toMatch(INCIDENT_WORDS);
        expect(s.aircraft.maintenance).toBeUndefined();
      }
    }
    expect(n).toBeGreaterThan(40);
  });

  it('keeps an airborne flight heading to its planned destination (no diversion assumed)', () => {
    const { f, at } = midFlight();
    const s = buildNeutralScenarioFromFlight(schedule, f.flight, { atMs: at }).scenario;
    expect(s.airborne?.flight).toBe(f.flight);
    expect(s.airborne?.plannedDestination).toBe(f.to);
    expect(s.aircraft.station).toBe(f.to);
    expect(s.airborne?.squawk).toBe('normal');
    expect(s.world.cohorts.some((c) => c.flight === f.flight)).toBe(true);
  });

  it('is deterministic (the browser preview and the server build agree)', () => {
    const { f, at } = midFlight();
    const a = buildNeutralScenarioFromFlight(schedule, f.flight, { atMs: at });
    const b = buildNeutralScenarioFromFlight(generateDaySchedule('accent-air', '2026-09-27'), f.flight, {
      atMs: at,
    });
    expect(b.scenario).toEqual(a.scenario);
  });
});

describe('network slice and network-wide patches', () => {
  it('reads the region from the description', () => {
    expect(regionFromText(ASH)).toEqual({ label: 'United Kingdom, Europe', countries: ['GB'], wide: true });
    expect(regionFromText('Ash over Northern Ireland and Ireland')?.countries).toEqual(['GB', 'IE']);
    expect(regionFromText('A passenger fell ill')).toBeNull();
  });

  it('lists airborne and departing flights, the anchor aircraft and the named region first', () => {
    const { f, at } = midFlight();
    const slice = networkSlice(schedule, at, { text: ASH, anchorFlight: f.flight });
    expect(slice.flights.length).toBeGreaterThan(5);
    expect(slice.flights.length).toBeLessThanOrEqual(40);
    expect(slice.flights[0]!.tail).toBe(f.tail);
    expect(slice.flights.some((x) => x.position)).toBe(true);
    // UK-only (not wide): every flight touches the UK or is the anchor aircraft.
    const uk = networkSlice(schedule, at, { text: 'UK airspace closed', anchorFlight: f.flight });
    expect(uk.region?.wide).toBe(false);
  });

  it('merges an airspace-closure patch into a multi-flight scenario, and rejects unknown flights', () => {
    const { f, at } = midFlight();
    const built = buildNeutralScenarioFromFlight(schedule, f.flight, { atMs: at });
    const base = built.scenario;
    const slice = networkSlice(schedule, Date.parse(base.startSimTime), {
      text: ASH,
      anchorFlight: f.flight,
    });
    const others = slice.flights.filter((x) => x.flight !== f.flight);
    const air = others.filter((x) => x.position).slice(0, 2);
    const ground = others.filter((x) => !x.position).slice(0, 4);
    const patch: ScenarioPatch = {
      title: 'UK airspace closed: volcanic ash',
      replaceNarrative:
        'Volcanic ash: the UK closes its airspace. Flights to and from the UK are held or diverted.',
      replaceTrigger: {
        type: 'airspace-closure',
        scope: 'network',
        description: 'UK airspace closed due to volcanic ash',
        evidence: [{ kind: 'report', text: 'NOTAM: UK airspace closed to IFR traffic' }],
      },
      commanderDecision: { atMinute: 4, decision: 'divert', airport: 'CDG', note: 'Diverting to Paris.' },
      network: {
        flights: [
          ...ground.map((x, i) => ({
            flight: x.flight,
            effect: i === 0 ? ('cancel' as const) : ('hold' as const),
            ...(i === 0 ? {} : { minutes: 120 }),
          })),
          ...air.map((x) => ({ flight: x.flight, effect: 'divert' as const, divertTo: 'DUB', atMinute: 5 })),
        ],
      },
    };
    expect(networkPatchErrors(base, patch, slice)).toEqual([]);
    const s = applyAuthoredPatch(base, patch, slice);
    const v = validateScenario(s);
    expect(v.ok ? [] : v.errors).toEqual([]);
    expect(s.trigger.type).toBe('airspace-closure');
    expect(s.trigger.scope).toBe('network');
    expect(scenarioFlightCount(s)).toBeGreaterThanOrEqual(1 + ground.length + air.length);
    expect(s.world.airborneFlights?.map((a) => a.flight)).toEqual(air.map((a) => a.flight));
    for (const g of ground) expect(s.world.cohorts.some((c) => c.flight === g.flight)).toBe(true);
    expect(s.twists.find((t) => t.id === 'tw-commander-decision')?.title).toBe('Commander: diverting to CDG');
    expect(s.twists.some((t) => t.id.startsWith('net-'))).toBe(true);
    expect(JSON.stringify(s)).not.toMatch(/fume|smell|acrid/i);

    const bad: ScenarioPatch = {
      network: { flights: [{ flight: 'ACX999', effect: 'delay', minutes: 30 }] },
    };
    expect(networkPatchErrors(base, bad, slice).join(' ')).toMatch(
      /ACX999 is not in the day's network slice/,
    );
    expect(networkPatchErrors(base, bad, undefined).join(' ')).toMatch(/no network slice/);
    if (ground[0])
      expect(
        networkPatchErrors(
          base,
          { network: { flights: [{ flight: ground[0].flight, effect: 'divert', divertTo: 'DUB' }] } },
          slice,
        ).join(' '),
      ).toMatch(/not in the air/);
  });
});
