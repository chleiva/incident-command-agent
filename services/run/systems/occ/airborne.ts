/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Airborne flights in OCC (task 07): the flight-following view of an aircraft in the air. Pure.
 * - Seeded from `scenario.airborne`; heading to the planned destination until the commander's decision (a scenario
 *   or presenter event) changes `destination` and `etaMinute`.
 * - `tick`: approach in the last 12 minutes, landed at `etaMinute` (position snaps to the destination airport).
 * - Squawk and the commander's decision are never set by agents: no tool writes them.
 */
import { getStation } from '@ica/kb';
import { bearingDeg, interpolateGreatCircle } from '@ica/network';
import type { AirborneFlight, Scenario, SystemMutation, SystemState } from '@ica/schema';
import { updated } from '../util';

export const APPROACH_MIN = 12;
const DESCENT_MIN = 25;

export function seedAirborne(scenario: Scenario): Record<string, AirborneFlight> {
  const out: Record<string, AirborneFlight> = {};
  // Addition (authoritative free text): other network flights in the air (network-wide events).
  for (const n of scenario.world.airborneFlights ?? []) {
    out[n.flight] = {
      flight: n.flight,
      tail: n.tail,
      phase: n.etaMinute <= APPROACH_MIN ? 'approach' : 'airborne',
      squawk: n.squawk,
      from: n.from,
      plannedDestination: n.plannedDestination,
      destination: n.plannedDestination,
      lat: n.position.lat,
      lon: n.position.lon,
      positionAtMinute: 0,
      altitudeFt: n.altitudeFt,
      headingDeg: n.headingDeg,
      etaMinute: n.etaMinute,
      fuelEnduranceMin: n.fuelEnduranceMin,
      pax: n.pax,
    };
  }
  const a = scenario.airborne;
  if (!a) return out;
  return {
    ...out,
    [a.flight]: {
      flight: a.flight,
      tail: scenario.aircraft.tail,
      phase: a.etaMinute <= APPROACH_MIN ? 'approach' : 'airborne',
      squawk: a.squawk,
      from: a.from,
      plannedDestination: a.plannedDestination,
      destination: a.plannedDestination,
      lat: a.position.lat,
      lon: a.position.lon,
      positionAtMinute: 0,
      altitudeFt: a.altitudeFt,
      headingDeg: a.headingDeg,
      etaMinute: a.etaMinute,
      fuelEnduranceMin: a.fuelEnduranceMin,
      pax: a.pax,
    },
  };
}

export interface AirborneNow {
  flight: string;
  phase: AirborneFlight['phase'];
  squawk: AirborneFlight['squawk'];
  lat: number;
  lon: number;
  altitudeFt: number;
  headingDeg: number;
  destination: string;
  plannedDestination: string;
  etaMinute: number;
  minutesToLanding: number;
  fuelEnduranceMin: number;
  commanderDecision?: AirborneFlight['commanderDecision'];
}

/** Where the aircraft is at `minute`: along the great circle from its last fix to the destination airport. */
export function airborneNow(a: AirborneFlight, minute: number): AirborneNow {
  const dest = getStation(a.destination);
  const landed = a.phase === 'landed' || minute >= a.etaMinute;
  const span = Math.max(1, a.etaMinute - a.positionAtMinute);
  const f = Math.min(1, Math.max(0, (minute - a.positionAtMinute) / span));
  const from = { lat: a.lat, lon: a.lon };
  const to = dest ? { lat: dest.lat, lon: dest.lon } : from;
  const pos = landed ? to : interpolateGreatCircle(from, to, f);
  const remaining = Math.max(0, a.etaMinute - minute);
  const altitudeFt = landed
    ? 0
    : remaining < DESCENT_MIN
      ? Math.round((Math.min(a.altitudeFt, 30000) * remaining) / DESCENT_MIN)
      : a.altitudeFt;
  return {
    flight: a.flight,
    phase: landed ? 'landed' : remaining <= APPROACH_MIN ? 'approach' : 'airborne',
    squawk: a.squawk,
    lat: Math.round(pos.lat * 1000) / 1000,
    lon: Math.round(pos.lon * 1000) / 1000,
    altitudeFt,
    headingDeg: landed ? a.headingDeg : Math.round(bearingDeg(pos, to)),
    destination: a.destination,
    plannedDestination: a.plannedDestination,
    etaMinute: a.etaMinute,
    minutesToLanding: Math.round(remaining),
    fuelEnduranceMin: Math.max(0, Math.round(a.fuelEnduranceMin - (minute - a.positionAtMinute))),
    ...(a.commanderDecision ? { commanderDecision: a.commanderDecision } : {}),
  };
}

export function tickAirborne(state: SystemState, simMinute: number): SystemMutation[] {
  const out: SystemMutation[] = [];
  for (const a of Object.values(state.occ.airborne ?? {})) {
    if (a.phase === 'landed') continue;
    if (simMinute >= a.etaMinute) {
      const now = airborneNow(a, a.etaMinute);
      out.push(
        updated('occ', 'airborne', a.flight, a, {
          phase: 'landed',
          landedAtMinute: a.etaMinute,
          lat: now.lat,
          lon: now.lon,
          positionAtMinute: a.etaMinute,
          altitudeFt: 0,
        }),
      );
    } else if (a.phase === 'airborne' && a.etaMinute - simMinute <= APPROACH_MIN) {
      out.push(updated('occ', 'airborne', a.flight, a, { phase: 'approach' }));
    }
  }
  return out;
}
