/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import { validateScenario } from '@ica/schema';
import { describe, expect, it } from 'vitest';
import { generateDaySchedule } from '../schedule';
import { flightTimes } from '../state';
import { stationByIata } from '../stations';
import {
  GROUND_INCIDENT_TYPES,
  buildScenarioFromFlight,
  createRemapper,
  incidentContext,
  incidentTypesFor,
  TemplateError,
} from './index';

const schedule = generateDaySchedule('accent-air', '2026-09-27');

/** Instants that put each flight in each of its ground phases. */
function probeTimes(f: (typeof schedule.flights)[number]): number[] {
  const t = flightTimes(f);
  return [
    t.offBlockMs - 90 * 60_000,
    t.offBlockMs - 20 * 60_000,
    t.offBlockMs + 5 * 60_000,
    t.landingMs + 3 * 60_000,
    t.inBlockMs + 15 * 60_000,
  ];
}

describe('incident types by phase', () => {
  it('offers ground types before departure and after landing, airborne types in the air', () => {
    const f = schedule.flights.find((x) => !x.cancelled && x.distanceKm > 1000)!;
    const t = flightTimes(f);
    const air = incidentTypesFor(incidentContext(schedule, f.flight, (t.takeoffMs + t.landingMs) / 2)!);
    expect(air.every((o) => o.type.category === 'airborne')).toBe(true);
    const board = incidentTypesFor(incidentContext(schedule, f.flight, t.offBlockMs - 20 * 60_000)!);
    expect(board.some((o) => o.enabled)).toBe(true);
    expect(board.every((o) => o.type.category === 'ground')).toBe(true);
    // Startable first.
    const firstDisabled = board.findIndex((o) => !o.enabled);
    if (firstDisabled >= 0) expect(board.slice(firstDisabled).every((o) => !o.enabled)).toBe(true);
  });
});

describe('buildScenarioFromFlight', () => {
  it('builds a schema-valid scenario for every flight × applicable ground type in a seeded day', () => {
    let built = 0;
    const perType = new Map<string, number>();
    for (const f of schedule.flights) {
      for (const at of probeTimes(f)) {
        const ctx = incidentContext(schedule, f.flight, at)!;
        for (const o of incidentTypesFor(ctx).filter((x) => x.enabled)) {
          const b = buildScenarioFromFlight(schedule, f.flight, o.type.id, { atMs: at });
          const v = validateScenario(b.scenario);
          expect(v.ok ? [] : v.errors, `${f.flight} ${o.type.id}`).toEqual([]);
          const s = b.scenario;
          expect(s.aircraft.tail).toBe(f.tail);
          expect(s.aircraft.station).toBe(ctx.station);
          expect(s.aircraft.nextSectors[0]!.flight).toBe(ctx.nextSectors[0]!.flight);
          expect(s.visibility).toBe('private');
          // Every flight mentioned is in the rotation; every station is real; no template tail leaks through.
          const text = JSON.stringify(s);
          const rotation = new Set(s.world.rotation.map((l) => l.flight));
          for (const fl of new Set(text.match(/ACX\d{3}/g)))
            expect(rotation.has(fl), `${o.type.id} ${fl}`).toBe(true);
          for (const st of [
            s.aircraft.station,
            ...s.world.engineers.map((e) => e.station),
            ...s.world.stands.map((x) => x.station),
          ])
            expect(stationByIata(st), st).toBeDefined();
          expect(new Set(s.world.rotation.map((l) => l.flight)).size).toBe(s.world.rotation.length);
          // Passengers on the first sector add up.
          const firstPax = s.world.cohorts
            .filter((c) => c.flight === s.aircraft.nextSectors[0]!.flight)
            .reduce((n, c) => n + c.count, 0);
          expect(firstPax).toBe(s.aircraft.nextSectors[0]!.pax);
          built++;
          perType.set(o.type.id, (perType.get(o.type.id) ?? 0) + 1);
        }
      }
    }
    expect(built).toBeGreaterThan(300);
    for (const t of GROUND_INCIDENT_TYPES) expect(perType.get(t.id) ?? 0, t.id).toBeGreaterThan(0);
  });

  it('is deterministic and refuses types that do not apply', () => {
    const f = schedule.flights.find((x) => !x.cancelled && x.from === 'MAN')!;
    const at = flightTimes(f).offBlockMs - 20 * 60_000;
    const a = buildScenarioFromFlight(schedule, f.flight, 'hydraulic_leak', { atMs: at });
    const b = buildScenarioFromFlight(schedule, f.flight, 'hydraulic_leak', { atMs: at });
    expect(b.scenario).toEqual(a.scenario);
    expect(() => buildScenarioFromFlight(schedule, f.flight, 'lightning_strike', { atMs: at })).toThrow(
      TemplateError,
    );
    expect(() => buildScenarioFromFlight(schedule, 'ACX000', 'fuel_spill')).toThrow(/not in the/);
    expect(() => buildScenarioFromFlight(schedule, f.flight, 'nope', { atMs: at })).toThrow(
      /unknown incident type/,
    );
  });
});

describe('remap', () => {
  it('replaces whole tokens, codes inside ids, and shifts times', () => {
    const r = createRemapper({
      tokens: { 'AX-MAB': 'AX-QQQ', ACX211: 'ACX123', MAN: 'EDI', Manchester: 'Edinburgh' },
      idCodes: { man: 'edi' },
      shiftMs: 90 * 60_000,
    });
    expect(r.string('AX-MAB at MAN (Manchester) as ACX211; ACX2110 stays')).toBe(
      'AX-QQQ at EDI (Edinburgh) as ACX123; ACX2110 stays',
    );
    expect(r.string('eng-man-b1a')).toBe('eng-edi-b1a');
    expect(r.string('a man walks')).toBe('a man walks');
    expect(r.string('2026-07-03T07:00:00Z')).toBe('2026-07-03T08:30:00Z');
    expect(r.string('update by 08:00.')).toBe('update by 09:30.');
    expect(r.value({ fromLocal: '23:30', MAN: 1 })).toEqual({ fromLocal: '23:30', EDI: 1 });
  });
});
