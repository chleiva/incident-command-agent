/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Accent Air's fictional day: ~22 tails (A319/A320/A321) based at MAN (main), LGW and EDI flying out-and-back
 * rotations to real European airports. Deterministic for a (seed, date). All times are UTC; UK bases are treated
 * as UTC (the simulation ignores summer time), so "first wave 06:00–07:30" is 06:00–07:30Z.
 *
 * Rules: first departure 06:00–07:30, turns ≥ 35 min (40–55 at outstations, 45–60 at base), every tail
 * night-stops at its base, the last arrival at base is at or before 23:00 (before any curfew), no departure before
 * 06:00. A few seeded primary delays propagate along the rotation as reactionary delay; occasionally one
 * out-and-back pair is cancelled.
 */
import { haversineKm } from './geo';
import { createRng, type Rng } from './rng';
import { BASES, ROUTES, stationByIata, type BaseIata } from './stations';

export type NetworkAircraftType = 'A319' | 'A320' | 'A321';

export const SEATS: Record<NetworkAircraftType, number> = { A319: 144, A320: 180, A321: 220 };

export interface NetworkTail {
  tail: string;
  type: NetworkAircraftType;
  seats: number;
  base: BaseIata;
}

export interface NetworkFlight {
  /** Unique in the day (the flight number). */
  flight: string;
  tail: string;
  type: NetworkAircraftType;
  from: string;
  to: string;
  /** Scheduled times, ISO UTC. */
  std: string;
  sta: string;
  stdMs: number;
  staMs: number;
  blockMin: number;
  distanceKm: number;
  /** Seeded primary (own-cause) departure delay. */
  primaryDelayMin: number;
  /** Knock-on delay from the late inbound aircraft. */
  reactionaryDelayMin: number;
  /** Total expected departure delay = primary + reactionary. */
  delayMin: number;
  pax: number;
  seats: number;
  /** Position in the tail's rotation (0-based). */
  leg: number;
  cancelled: boolean;
}

/** An operating crew's duty on one tail (simplified: crews change only at base). */
export interface CrewDuty {
  id: string;
  tail: string;
  base: BaseIata;
  reportMs: number;
  report: string;
  sectors: number;
  /** Simplified maximum flight duty period (minutes), from report time and sectors. */
  maxFdpMin: number;
  /** The flights this crew operates, in order. */
  flights: string[];
}

export interface DaySchedule {
  seed: string;
  /** YYYY-MM-DD (UTC). */
  date: string;
  carrier: { name: string; code: string };
  tails: NetworkTail[];
  flights: NetworkFlight[];
  crews: CrewDuty[];
}

export const MIN_TURN_MIN = 35;
export const TAXI_OUT_MIN = 12;
export const TAXI_IN_MIN = 8;
const LAST_BASE_ARRIVAL_MIN = 23 * 60; // 23:00Z
const FIRST_DEPARTURE_MIN = 6 * 60;
/** Upper bound on the day's flights (the brief: about 60–80). */
export const MAX_FLIGHTS = 80;

/** Block time (minutes, rounded up to 5) for a sector: taxi + climb/descent allowance + cruise at ~780 km/h. */
export function blockMinutes(distanceKm: number): number {
  const raw = TAXI_OUT_MIN + TAXI_IN_MIN + 20 + (distanceKm / 780) * 60;
  return Math.ceil(raw / 5) * 5;
}

const TAIL_COUNT: Record<BaseIata, number> = { MAN: 12, LGW: 6, EDI: 4 };
const FLIGHT_RANGE: Record<BaseIata, [number, number]> = {
  MAN: [101, 499],
  LGW: [501, 799],
  EDI: [801, 999],
};

function dayStartMs(date: string): number {
  const ms = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(ms)) throw new Error(`generateDaySchedule: invalid date '${date}' (expected YYYY-MM-DD)`);
  return ms;
}

function makeTails(rng: Rng): NetworkTail[] {
  const used = new Set<string>();
  const letters = 'ABCDEFGHJKLMNPRSTUVWXYZ';
  const tails: NetworkTail[] = [];
  for (const base of BASES) {
    for (let i = 0; i < TAIL_COUNT[base]; i++) {
      let reg = '';
      do {
        reg = `AX-${rng.pick([...letters])}${rng.pick([...letters])}${rng.pick([...letters])}`;
      } while (used.has(reg));
      used.add(reg);
      const r = rng.next();
      const type: NetworkAircraftType = r < 0.2 ? 'A319' : r < 0.75 ? 'A320' : 'A321';
      tails.push({ tail: reg, type, seats: SEATS[type], base });
    }
  }
  return tails;
}

function iso(ms: number): string {
  return new Date(ms).toISOString().replace('.000Z', 'Z');
}

/** Simplified max FDP: 13 h for a report 06:00–13:29 Z with up to 2 sectors, less 30 min per extra sector (min 9 h). */
export function simplifiedMaxFdp(reportMinuteOfDay: number, sectors: number): number {
  const base = reportMinuteOfDay >= 6 * 60 && reportMinuteOfDay < 13.5 * 60 ? 780 : 720;
  return Math.max(540, base - 30 * Math.max(0, sectors - 2));
}

/**
 * Generate the day. Deterministic: the same (seed, date) always gives the same schedule. Only the date's day
 * start is used; the weekday does not matter.
 */
export function generateDaySchedule(seed: string, dateUtc: string): DaySchedule {
  const rng = createRng(`${seed}|${dateUtc}`);
  const day0 = dayStartMs(dateUtc);
  const tails = makeTails(rng);
  const flights: NetworkFlight[] = [];
  const crews: CrewDuty[] = [];
  const nextNumber: Record<BaseIata, number> = {
    MAN: FLIGHT_RANGE.MAN[0] + 2 * rng.int(0, 10),
    LGW: FLIGHT_RANGE.LGW[0] + 2 * rng.int(0, 10),
    EDI: FLIGHT_RANGE.EDI[0] + 2 * rng.int(0, 10),
  };
  let cancelledPairDone = !rng.chance(0.6);

  tails.forEach((t, ti) => {
    const base = stationByIata(t.base)!;
    // Round trips planned for the day: mostly two, some one (long sectors), a few three (short sectors). The
    // day is capped at MAX_FLIGHTS, keeping room for one round trip on every remaining tail.
    const r = rng.next();
    const wanted = r < 0.3 ? 1 : r < 0.92 ? 2 : 3;
    const room = Math.floor((MAX_FLIGHTS - flights.length - 2 * (tails.length - ti - 1)) / 2);
    const plannedPairs = Math.max(1, Math.min(wanted, room));
    let clock = FIRST_DEPARTURE_MIN + 5 * rng.int(0, 18); // 06:00–07:30
    const legs: NetworkFlight[] = [];
    const usedDest = new Set<string>();
    for (let pair = 0; pair < plannedPairs; pair++) {
      const options = ROUTES[t.base].filter((d) => {
        if (usedDest.has(d)) return false;
        const km = haversineKm(base, stationByIata(d)!);
        // Three-pair days only use short sectors; single-pair days prefer long ones.
        if (plannedPairs === 3 && km > 1300) return false;
        if (t.type === 'A319' && km > 2600) return false;
        return true;
      });
      if (options.length === 0) break;
      const dest = rng.pick(options);
      const destSt = stationByIata(dest)!;
      const km = Math.round(haversineKm(base, destSt));
      const block = blockMinutes(km);
      const turnOut = 5 * rng.int(8, 11); // 40–55
      const arriveBack = clock + block + turnOut + block;
      if (arriveBack > LAST_BASE_ARRIVAL_MIN) break;
      usedDest.add(dest);
      const outNo = nextNumber[t.base];
      nextNumber[t.base] += 2;
      const [lo, hi] = FLIGHT_RANGE[t.base];
      if (nextNumber[t.base] > hi) nextNumber[t.base] = lo;
      const mk = (from: string, to: string, depMin: number, num: number): NetworkFlight => {
        const stdMs = day0 + depMin * 60_000;
        const staMs = stdMs + block * 60_000;
        const loadFactor = 0.72 + rng.next() * 0.26;
        return {
          flight: `ACX${num}`,
          tail: t.tail,
          type: t.type,
          from,
          to,
          std: iso(stdMs),
          sta: iso(staMs),
          stdMs,
          staMs,
          blockMin: block,
          distanceKm: km,
          primaryDelayMin: 0,
          reactionaryDelayMin: 0,
          delayMin: 0,
          pax: Math.min(t.seats, Math.round(t.seats * loadFactor)),
          seats: t.seats,
          leg: 0,
          cancelled: false,
        };
      };
      legs.push(mk(t.base, dest, clock, outNo));
      legs.push(mk(dest, t.base, clock + block + turnOut, outNo + 1));
      clock = arriveBack + 5 * rng.int(9, 12); // base turn 45–60
    }
    // Seeded primary delays, then propagate knock-on delay along the rotation.
    legs.forEach((f, i) => {
      f.leg = i;
      const p = i === 0 ? 0.25 : 0.12;
      if (rng.chance(p)) f.primaryDelayMin = 5 * rng.int(1, 8);
    });
    if (!cancelledPairDone && legs.length >= 4 && rng.chance(0.35)) {
      legs[legs.length - 1]!.cancelled = true;
      legs[legs.length - 2]!.cancelled = true;
      cancelledPairDone = true;
    }
    let readyMs = -Infinity;
    for (const f of legs) {
      if (f.cancelled) continue;
      f.reactionaryDelayMin = Math.max(0, Math.round((readyMs - f.stdMs) / 60_000));
      f.delayMin = f.primaryDelayMin + f.reactionaryDelayMin;
      const inBlock = f.staMs + f.delayMin * 60_000;
      readyMs = inBlock + MIN_TURN_MIN * 60_000;
    }
    flights.push(...legs);
    // Crew pairings: a crew takes out-and-back pairs from base while the scheduled FDP stays within its limit
    // (less a 60-min buffer); crews change only at base.
    const flown = legs.filter((f) => !f.cancelled);
    let n = 0;
    for (let i = 0; i < flown.length;) {
      const reportMs = flown[i]!.stdMs - 60 * 60_000;
      const pairing: NetworkFlight[] = [];
      while (i < flown.length) {
        const pair = flown.slice(i, i + 2);
        const candidate = [...pairing, ...pair];
        const fdp = (pair.at(-1)!.staMs - reportMs) / 60_000;
        const max = simplifiedMaxFdp((reportMs - day0) / 60_000, candidate.length);
        if (pairing.length && fdp > max - 60) break;
        pairing.push(...pair);
        i += pair.length;
      }
      crews.push({
        id: `crew-${t.tail.slice(3).toLowerCase()}-${++n}`,
        tail: t.tail,
        base: t.base,
        reportMs,
        report: iso(reportMs),
        sectors: pairing.length,
        maxFdpMin: simplifiedMaxFdp((reportMs - day0) / 60_000, pairing.length),
        flights: pairing.map((f) => f.flight),
      });
    }
  });
  flights.sort((a, b) => a.stdMs - b.stdMs || a.flight.localeCompare(b.flight));
  return { seed, date: dateUtc, carrier: { name: 'Accent Air', code: 'ACX' }, tails, flights, crews };
}

/** The tail's legs for the day, in order. */
export function rotationOf(schedule: DaySchedule, tail: string): NetworkFlight[] {
  return schedule.flights.filter((f) => f.tail === tail).sort((a, b) => a.stdMs - b.stdMs);
}

export function findFlight(schedule: DaySchedule, flight: string): NetworkFlight | undefined {
  return schedule.flights.find((f) => f.flight === flight);
}

/** Today's schedule date (UTC) for a wall-clock instant. */
export function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The default seed of the public demo network. */
export const DEFAULT_NETWORK_SEED = 'accent-air';
