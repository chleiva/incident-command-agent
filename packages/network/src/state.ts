/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * A flight's state at an instant: phase, great-circle position, heading, a notional altitude profile, ETA,
 * progress and a notional fuel-endurance figure. Pure: the same flight and instant always give the same state.
 */
import { bearingDeg, interpolateGreatCircle, type LatLon } from './geo';
import { TAXI_IN_MIN, TAXI_OUT_MIN, type NetworkFlight } from './schedule';
import { stationByIata } from './stations';

export const FLIGHT_PHASES = [
  'scheduled',
  'boarding',
  'taxi_out',
  'airborne',
  'approach',
  'landed',
  'at_gate',
  'cancelled',
] as const;
export type FlightPhase = (typeof FLIGHT_PHASES)[number];

export const AIRBORNE_PHASES: readonly FlightPhase[] = ['airborne', 'approach'];
export const GROUND_PHASES: readonly FlightPhase[] = [
  'scheduled',
  'boarding',
  'taxi_out',
  'landed',
  'at_gate',
];

export const BOARDING_MIN = 40;
const CLIMB_MIN = 20;
const DESCENT_MIN = 25;
const APPROACH_MIN = 12;
/** Notional fixed reserve + alternate allowance on top of the remaining trip (minutes). Illustrative only. */
export const NOTIONAL_RESERVE_MIN = 75;

export interface FlightTimes {
  offBlockMs: number;
  takeoffMs: number;
  landingMs: number;
  inBlockMs: number;
}

export interface FlightState {
  flight: string;
  phase: FlightPhase;
  /** Where the aircraft is: airborne position, or the station it is at. */
  position: LatLon;
  /** The station while on the ground (departure before take-off, arrival after landing). */
  station?: string;
  /** True heading (degrees) while airborne. */
  headingDeg?: number;
  /** Notional altitude (ft): 0 on the ground. */
  altitudeFt: number;
  /** Estimated in-block time, ISO. */
  eta: string;
  etaMs: number;
  /** Estimated off-block time, ISO. */
  etd: string;
  /** 0 before take-off … 1 at landing. */
  progress: number;
  /** Notional fuel endurance (minutes) while airborne; illustrative, not a flight-planning figure. */
  fuelEnduranceMin?: number;
  /** Minutes until landing while airborne. */
  minutesToLanding?: number;
  times: FlightTimes;
}

export function flightTimes(f: NetworkFlight): FlightTimes {
  const offBlockMs = f.stdMs + f.delayMin * 60_000;
  const inBlockMs = f.staMs + f.delayMin * 60_000;
  return {
    offBlockMs,
    takeoffMs: offBlockMs + TAXI_OUT_MIN * 60_000,
    landingMs: inBlockMs - TAXI_IN_MIN * 60_000,
    inBlockMs,
  };
}

function cruiseFt(distanceKm: number): number {
  if (distanceKm < 500) return 28000;
  if (distanceKm < 1000) return 34000;
  return 37000;
}

const iso = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z');

export function flightStateAt(f: NetworkFlight, tMs: number): FlightState {
  const times = flightTimes(f);
  const from = stationByIata(f.from);
  const to = stationByIata(f.to);
  const a: LatLon = from ? { lat: from.lat, lon: from.lon } : { lat: 0, lon: 0 };
  const b: LatLon = to ? { lat: to.lat, lon: to.lon } : { lat: 0, lon: 0 };
  const base = {
    flight: f.flight,
    eta: iso(times.inBlockMs),
    etaMs: times.inBlockMs,
    etd: iso(times.offBlockMs),
    times,
  };
  if (f.cancelled) {
    return { ...base, phase: 'cancelled', position: a, station: f.from, altitudeFt: 0, progress: 0 };
  }
  if (tMs < times.takeoffMs) {
    const phase: FlightPhase =
      tMs >= times.offBlockMs
        ? 'taxi_out'
        : tMs >= times.offBlockMs - BOARDING_MIN * 60_000
          ? 'boarding'
          : 'scheduled';
    return { ...base, phase, position: a, station: f.from, altitudeFt: 0, progress: 0 };
  }
  if (tMs >= times.landingMs) {
    const phase: FlightPhase = tMs >= times.inBlockMs ? 'at_gate' : 'landed';
    return { ...base, phase, position: b, station: f.to, altitudeFt: 0, progress: 1 };
  }
  const airborneMin = (times.landingMs - times.takeoffMs) / 60_000;
  const elapsed = (tMs - times.takeoffMs) / 60_000;
  const remaining = airborneMin - elapsed;
  const progress = Math.min(1, Math.max(0, elapsed / airborneMin));
  const position = interpolateGreatCircle(a, b, progress);
  const climb = Math.min(CLIMB_MIN, airborneMin / 3);
  const descent = Math.min(DESCENT_MIN, airborneMin / 3);
  const cruise = cruiseFt(f.distanceKm);
  const altitudeFt = Math.round(
    elapsed < climb
      ? (cruise * elapsed) / climb
      : remaining < descent
        ? (cruise * remaining) / descent
        : cruise,
  );
  return {
    ...base,
    phase: remaining <= APPROACH_MIN ? 'approach' : 'airborne',
    position,
    headingDeg: Math.round(bearingDeg(position, b)),
    altitudeFt,
    progress,
    fuelEnduranceMin: Math.round(remaining + NOTIONAL_RESERVE_MIN),
    minutesToLanding: Math.round(remaining),
  };
}

export function isAirborne(phase: FlightPhase): boolean {
  return phase === 'airborne' || phase === 'approach';
}

/** Plain-language phase labels for the UI. */
export const PHASE_LABEL: Record<FlightPhase, string> = {
  scheduled: 'Scheduled',
  boarding: 'Boarding',
  taxi_out: 'Taxiing out',
  airborne: 'Airborne',
  approach: 'On approach',
  landed: 'Landed',
  at_gate: 'At gate',
  cancelled: 'Cancelled',
};
