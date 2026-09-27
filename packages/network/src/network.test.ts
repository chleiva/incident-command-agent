/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FLIGHT_NUMBER_PATTERN, TAIL_PATTERN } from '@ica/schema/browser';
import {
  AIRPORT_CAPABILITIES,
  BASES,
  MIN_TURN_MIN,
  NETWORK_STATIONS,
  OPTIONS_ONLY_NOTE,
  capabilityOf,
  cohortsFor,
  crossTrackKm,
  fdpMarginFor,
  flightStateAt,
  flightTimes,
  generateDaySchedule,
  haversineKm,
  isAirborne,
  rotationOf,
  stationByIata,
  suitableAirports,
  tailStatesAt,
} from './index';

const DATES = ['2026-07-03', '2026-09-27', '2026-12-24', '2027-02-11'];
const SEEDS = ['accent-air', 'seed-2', 'demo'];

describe('stations', () => {
  it('match data/airports/stations.json (OurAirports)', () => {
    const raw = JSON.parse(
      readFileSync(new URL('../../../data/airports/stations.json', import.meta.url), 'utf8'),
    ) as { stations: { iata: string; icao: string; lat: number; lon: number; utcStdOffsetMin: number }[] };
    const byIata = new Map(raw.stations.map((s) => [s.iata, s]));
    for (const s of NETWORK_STATIONS) {
      const r = byIata.get(s.iata);
      expect(r, s.iata).toBeDefined();
      expect(s.icao).toBe(r!.icao);
      expect(Math.abs(s.lat - r!.lat)).toBeLessThan(1e-4);
      expect(Math.abs(s.lon - r!.lon)).toBeLessThan(1e-4);
      expect(s.utcStdOffsetMin).toBe(r!.utcStdOffsetMin);
    }
  });

  it('have one capability record each, labelled fictional where invented', () => {
    expect(AIRPORT_CAPABILITIES).toHaveLength(NETWORK_STATIONS.length);
    for (const c of AIRPORT_CAPABILITIES) {
      expect(c.fictional).toContain('engineering');
      expect(c.runwayM).toBeGreaterThan(1000);
    }
    expect(capabilityOf('MAN')?.engineering).toBe('own');
  });
});

describe('generateDaySchedule', () => {
  it('is deterministic for a seed and date', () => {
    const a = generateDaySchedule('accent-air', '2026-09-27');
    const b = generateDaySchedule('accent-air', '2026-09-27');
    expect(b).toEqual(a);
    const c = generateDaySchedule('accent-air', '2026-09-28');
    expect(c.flights.map((f) => f.flight + f.to)).not.toEqual(a.flights.map((f) => f.flight + f.to));
  });

  for (const seed of SEEDS)
    for (const date of DATES) {
      it(`produces a realistic day (${seed}, ${date})`, () => {
        const s = generateDaySchedule(seed, date);
        expect(s.tails.length).toBeGreaterThanOrEqual(20);
        expect(s.tails.length).toBeLessThanOrEqual(24);
        expect(s.flights.length).toBeGreaterThanOrEqual(60);
        expect(s.flights.length).toBeLessThanOrEqual(80);
        const numbers = new Set(s.flights.map((f) => f.flight));
        expect(numbers.size).toBe(s.flights.length);
        const day0 = Date.parse(`${date}T00:00:00Z`);
        for (const f of s.flights) {
          expect(f.flight).toMatch(new RegExp(FLIGHT_NUMBER_PATTERN));
          expect(f.tail).toMatch(new RegExp(TAIL_PATTERN));
          expect(stationByIata(f.from)).toBeDefined();
          expect(stationByIata(f.to)).toBeDefined();
          expect(f.pax).toBeLessThanOrEqual(f.seats);
          expect(f.staMs - f.stdMs).toBe(f.blockMin * 60_000);
          // No departure before 06:00Z; last arrivals at or before 23:00Z (before any curfew).
          expect(f.stdMs).toBeGreaterThanOrEqual(day0 + 6 * 3_600_000);
          expect(f.staMs).toBeLessThanOrEqual(day0 + 23 * 3_600_000);
          const cap = capabilityOf(f.to);
          if (cap?.curfew) {
            const local = new Date(f.staMs + stationByIata(f.to)!.utcStdOffsetMin * 60_000);
            const m = local.getUTCHours() * 60 + local.getUTCMinutes();
            const [fh, fm] = cap.curfew.fromLocal.split(':').map(Number);
            expect(m).toBeLessThan(fh! * 60 + fm! || 24 * 60);
          }
        }
        for (const t of s.tails) {
          const legs = rotationOf(s, t.tail);
          expect(legs.length).toBeGreaterThanOrEqual(2);
          // First wave 06:00–07:30.
          expect(legs[0]!.stdMs - day0).toBeGreaterThanOrEqual(6 * 3_600_000);
          expect(legs[0]!.stdMs - day0).toBeLessThanOrEqual(7.5 * 3_600_000);
          expect(legs[0]!.from).toBe(t.base);
          // Night-stop at base.
          expect(legs.at(-1)!.to).toBe(t.base);
          for (let i = 1; i < legs.length; i++) {
            const prev = legs[i - 1]!;
            const cur = legs[i]!;
            expect(cur.from).toBe(prev.to);
            // Scheduled turn ≥ 35 min, and no overlapping legs even with delays.
            expect(cur.stdMs - prev.staMs).toBeGreaterThanOrEqual(MIN_TURN_MIN * 60_000);
            if (!cur.cancelled && !prev.cancelled)
              expect(flightTimes(cur).offBlockMs - flightTimes(prev).inBlockMs).toBeGreaterThanOrEqual(
                MIN_TURN_MIN * 60_000,
              );
          }
        }
        expect(new Set(s.tails.map((t) => t.base))).toEqual(new Set(BASES));
      });
    }
});

describe('flightStateAt', () => {
  const s = generateDaySchedule('accent-air', '2026-09-27');
  const f = s.flights.find((x) => !x.cancelled && x.distanceKm > 1200)!;
  const t = flightTimes(f);

  it('gives the right phase around STD and STA', () => {
    expect(flightStateAt(f, t.offBlockMs - 3 * 3_600_000).phase).toBe('scheduled');
    expect(flightStateAt(f, t.offBlockMs - 10 * 60_000).phase).toBe('boarding');
    expect(flightStateAt(f, t.offBlockMs + 60_000).phase).toBe('taxi_out');
    expect(flightStateAt(f, t.takeoffMs + 60_000).phase).toBe('airborne');
    expect(flightStateAt(f, t.landingMs - 5 * 60_000).phase).toBe('approach');
    expect(flightStateAt(f, t.landingMs + 60_000).phase).toBe('landed');
    expect(flightStateAt(f, t.inBlockMs + 60_000).phase).toBe('at_gate');
  });

  it('puts an airborne aircraft on the great circle, with a climb-cruise-descent profile', () => {
    const a = stationByIata(f.from)!;
    const b = stationByIata(f.to)!;
    const total = haversineKm(a, b);
    let prevProgress = 0;
    for (const frac of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      const st = flightStateAt(f, t.takeoffMs + frac * (t.landingMs - t.takeoffMs));
      expect(isAirborne(st.phase)).toBe(true);
      expect(crossTrackKm(st.position, a, b)).toBeLessThan(1);
      expect(haversineKm(a, st.position)).toBeCloseTo(total * st.progress, 0);
      expect(st.progress).toBeGreaterThan(prevProgress);
      prevProgress = st.progress;
      expect(st.headingDeg).toBeGreaterThanOrEqual(0);
      expect(st.fuelEnduranceMin!).toBeGreaterThan(st.minutesToLanding!);
    }
    const mid = flightStateAt(f, (t.takeoffMs + t.landingMs) / 2);
    const early = flightStateAt(f, t.takeoffMs + 5 * 60_000);
    expect(mid.altitudeFt).toBeGreaterThan(early.altitudeFt);
    expect(mid.altitudeFt).toBeGreaterThanOrEqual(34000);
  });

  it('reports cancelled flights as cancelled', () => {
    const s2 = SEEDS.flatMap((seed) => DATES.map((d) => generateDaySchedule(seed, d)));
    const c = s2.flatMap((x) => x.flights).find((x) => x.cancelled);
    expect(c).toBeDefined();
    expect(flightStateAt(c!, c!.stdMs).phase).toBe('cancelled');
  });
});

describe('derived views', () => {
  const s = generateDaySchedule('accent-air', '2026-09-27');
  it('locates every tail at any time', () => {
    const noon = Date.parse('2026-09-27T12:00:00Z');
    const states = tailStatesAt(s, noon);
    expect(states).toHaveLength(s.tails.length);
    expect(states.some((x) => x.airborne)).toBe(true);
    const night = tailStatesAt(s, Date.parse('2026-09-27T23:59:00Z'));
    for (const x of night) {
      expect(x.airborne).toBe(false);
      expect(s.tails.find((t) => t.tail === x.tail)!.base).toBe(x.station);
    }
  });
  it('computes an FDP margin and cohorts', () => {
    const m = fdpMarginFor(s, s.flights[0]!.flight)!;
    for (const c of s.crews) {
      const last = s.flights.find((f) => f.flight === c.flights.at(-1))!;
      // Scheduled duty fits the (simplified) limit; only delays can eat the margin.
      if (c.flights.length > 2)
        expect((last.staMs - c.reportMs) / 60_000).toBeLessThanOrEqual(c.maxFdpMin - 60);
    }
    expect(m.maxFdpMin).toBeGreaterThanOrEqual(540);
    expect(m.marginMin).toBe(m.maxFdpMin - m.plannedFdpMin);
    const f = s.flights[0]!;
    const cohorts = cohortsFor(f);
    expect(cohorts.reduce((n, c) => n + c.count, 0)).toBe(f.pax);
    expect(cohortsFor(f)).toEqual(cohorts);
  });
});

describe('suitableAirports', () => {
  it('ranks nearby suitable airports first and filters short runways', () => {
    const overChannel = { lat: 49.5, lon: -2.3 }; // near Jersey
    const r = suitableAirports(overChannel, 'A320', { limit: 50, maxDistanceKm: 700 });
    expect(r.length).toBeGreaterThan(2);
    expect(r[0]!.suitable).toBe(true);
    const jer = r.find((x) => x.iata === 'JER');
    expect(jer?.suitable).toBe(false);
    expect(r.findIndex((x) => x.iata === 'JER')).toBeGreaterThan(r.findIndex((x) => x.suitable));
    expect(OPTIONS_ONLY_NOTE).toMatch(/commander decides/);
  });
  it('respects curfews when a time is given', () => {
    const nearLgw = { lat: 51.1, lon: -0.2 };
    const night = suitableAirports(nearLgw, 'A320', { atMs: Date.parse('2026-09-27T23:45:00Z'), limit: 20 });
    expect(night.find((x) => x.iata === 'LGW')?.suitable).toBe(false);
    const day = suitableAirports(nearLgw, 'A320', { atMs: Date.parse('2026-09-27T12:00:00Z') });
    expect(day[0]!.iata).toBe('LGW');
  });
});
