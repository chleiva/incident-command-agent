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

describe('placement: the incident happens on the selected flight, where it is now (demo review 2)', () => {
  // AX-ZZD: ACX125 MAN→PMI 06:40–09:25, ACX126 PMI→MAN 10:15–13:00 (ACX127/ACX128 cancelled today).
  const at = (hhmm: string) => Date.parse(`2026-09-27T${hhmm}:00Z`);
  const f125 = schedule.flights.find((f) => f.flight === 'ACX125')!;
  it('fixture: the live rotation', () => {
    expect([f125.from, f125.to, f125.tail]).toEqual(['MAN', 'PMI', 'AX-ZZD']);
  });

  it('before departure (boarding): on the selected flight at its departure station, no note', () => {
    const t = flightTimes(f125).offBlockMs - 20 * 60_000;
    const ctx = incidentContext(schedule, 'ACX125', t)!;
    expect(ctx.phase).toBe('boarding');
    expect(ctx.placement).toEqual({ kind: 'on_flight' });
    expect(ctx.station).toBe('MAN');
    const o = incidentTypesFor(ctx).find((x) => x.enabled)!;
    const b = buildScenarioFromFlight(schedule, 'ACX125', o.type.id, { atMs: t });
    expect(b.scenario.aircraft.station).toBe('MAN');
    expect(b.scenario.aircraft.nextSectors[0]!.flight).toBe('ACX125');
    expect(b.preview.placement).toBeUndefined();
    expect(Date.parse(b.scenario.startSimTime)).toBeGreaterThanOrEqual(
      Math.floor(t / 60_000) * 60_000 - 60 * 60_000,
    );
  });

  it('taxiing: on the selected flight at that station', () => {
    const t = flightTimes(f125).offBlockMs + 5 * 60_000;
    const ctx = incidentContext(schedule, 'ACX125', t)!;
    expect(ctx.phase).toBe('taxi_out');
    expect(ctx.placement.kind).toBe('on_flight');
    const o = incidentTypesFor(ctx).find((x) => x.enabled);
    if (o) {
      const b = buildScenarioFromFlight(schedule, 'ACX125', o.type.id, { atMs: t });
      expect(b.scenario.aircraft.station).toBe('MAN');
      expect(b.scenario.aircraft.nextSectors[0]!.flight).toBe('ACX125');
    }
  });

  it('airborne: in the air on the selected flight', () => {
    const t = at('07:30');
    const ctx = incidentContext(schedule, 'ACX125', t)!;
    expect(ctx.phase).toBe('airborne');
    expect(ctx.placement.kind).toBe('on_flight');
    const b = buildScenarioFromFlight(schedule, 'ACX125', 'diversion_medical', { atMs: t });
    expect(b.scenario.airborne?.flight).toBe('ACX125');
    expect(b.scenario.startSimTime).toBe('2026-09-27T07:30:00Z');
  });

  it('at the gate after landing: at that station, and the preview says it applies at the next turnaround', () => {
    const t = at('09:30');
    const ctx = incidentContext(schedule, 'ACX125', t)!;
    expect(ctx.phase).toBe('at_gate');
    expect(ctx.placement.kind).toBe('turnaround');
    expect(ctx.station).toBe('PMI');
    const b = buildScenarioFromFlight(schedule, 'ACX125', 'vehicle_strike', { atMs: t });
    expect(b.preview.placement).toMatch(/applies at the next turnaround: ACX126 at PMI \(due 10:15Z\)/);
    expect(b.scenario.title).toContain('ACX125 → ACX126');
    // The sim starts when the aircraft is at the gate and the report is made (not before ACX125 is in).
    expect(Date.parse(b.scenario.startSimTime)).toBeGreaterThanOrEqual(flightTimes(f125).inBlockMs);
    expect(b.scenario.startSimTime).toBe('2026-09-27T09:30:00Z');
  });

  it('live case: ACX125 selected at 22:47 (long landed; AX-ZZD back at the gate at MAN after ACX126) is not placed at PMI', () => {
    const t = at('22:47');
    const ctx = incidentContext(schedule, 'ACX125', t)!;
    expect(ctx.placement.kind).toBe('moved_on');
    expect(ctx.selected.flight).toBe('ACX125');
    expect(ctx.flight.flight).toBe('ACX126');
    expect(ctx.station).toBe('MAN');
    expect(ctx.placement.note).toMatch(/ACX125 landed at PMI at 09:25Z and AX-ZZD has flown on/);
    expect(ctx.placement.note).toMatch(/at the gate at MAN after ACX126/);
    expect(ctx.placement.note).toMatch(/no further flights today/);
    // No flights left today: ground incident types cannot start (the old behaviour built ACX126 at PMI at 09:20Z).
    expect(incidentTypesFor(ctx).filter((o) => o.enabled)).toEqual([]);
    expect(() => buildScenarioFromFlight(schedule, 'ACX125', 'vehicle_strike', { atMs: t })).toThrow(
      TemplateError,
    );
  });

  it("moved on and now airborne: placed in the air on the aircraft's current flight", () => {
    const t = at('11:30');
    const ctx = incidentContext(schedule, 'ACX125', t)!;
    expect(ctx.placement.kind).toBe('moved_on');
    expect(ctx.flight.flight).toBe('ACX126');
    expect(ctx.phase).toBe('airborne');
    const o = incidentTypesFor(ctx).find((x) => x.enabled)!;
    const b = buildScenarioFromFlight(schedule, 'ACX125', o.type.id, { atMs: t });
    expect(b.scenario.airborne?.flight).toBe('ACX126');
    expect(b.preview.placement).toMatch(/in the air as ACX126 to MAN/);
  });

  it('not there yet: a later flight selected while the aircraft is still on an earlier one says so', () => {
    const t = at('07:30');
    const ctx = incidentContext(schedule, 'ACX126', t)!;
    expect(ctx.placement.kind).toBe('not_there_yet');
    expect(ctx.placement.note).toMatch(/AX-ZZD is not at PMI yet \(it is in the air as ACX125 to PMI\)/);
    const o = incidentTypesFor(ctx).find((x) => x.enabled)!;
    const b = buildScenarioFromFlight(schedule, 'ACX126', o.type.id, { atMs: t });
    expect(Date.parse(b.scenario.startSimTime)).toBeGreaterThanOrEqual(flightTimes(f125).inBlockMs);
  });
});

describe('airborne types', () => {
  it('builds a valid airborne scenario for every airborne flight × applicable type', () => {
    const perType = new Map<string, number>();
    for (const f of schedule.flights.filter((x) => !x.cancelled)) {
      const t = flightTimes(f);
      for (const at of [t.takeoffMs + 6 * 60_000, (t.takeoffMs + t.landingMs) / 2]) {
        const ctx = incidentContext(schedule, f.flight, at)!;
        for (const o of incidentTypesFor(ctx).filter((x) => x.enabled && x.type.category === 'airborne')) {
          const b = buildScenarioFromFlight(schedule, f.flight, o.type.id, { atMs: at });
          const v = validateScenario(b.scenario);
          expect(v.ok ? [] : v.errors, `${f.flight} ${o.type.id}`).toEqual([]);
          const s = b.scenario;
          expect(s.airborne?.flight).toBe(f.flight);
          expect(s.airborne?.plannedDestination).toBe(f.to);
          const cmd = s.twists.find((x) => x.id === 'tw-commander-decision')!;
          const patch = cmd.effects.find((e) => e.op === 'patch');
          expect(patch && patch.op === 'patch' && patch.id).toBe(f.flight);
          expect(patch && patch.op === 'patch' && patch.patch.destination).toBe(s.aircraft.station);
          if (o.type.id === 'air_turnback') expect(s.aircraft.station).toBe(f.from);
          else if (o.type.id !== 'engine_shutdown_overweight_landing')
            expect(s.aircraft.station).not.toBe(f.to);
          perType.set(o.type.id, (perType.get(o.type.id) ?? 0) + 1);
        }
      }
    }
    for (const id of [
      'air_turnback',
      'diversion_technical',
      'diversion_medical',
      'engine_shutdown_overweight_landing',
      'unruly_passenger_diversion',
    ])
      expect(perType.get(id) ?? 0, id).toBeGreaterThan(0);
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
