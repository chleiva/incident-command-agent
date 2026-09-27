/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * The cockpit's view of an aircraft in the air (task 07): where it is at a sim minute, from the OCC `airborne`
 * record (last fix, destination, ETA). Mirrors the Run Lambda's flight-following model; pure.
 */
import { bearingDeg, interpolateGreatCircle, stationByIata } from '@ica/network';
import type { AirborneFlight } from '@ica/schema/browser';

export interface AirborneView {
  flight: string;
  lat: number;
  lon: number;
  headingDeg: number;
  phase: AirborneFlight['phase'];
  squawk: AirborneFlight['squawk'];
  destination: string;
  plannedDestination: string;
  minutesToLanding: number;
  commanderDecision?: AirborneFlight['commanderDecision'];
  diverted: boolean;
}

export function airborneAt(a: AirborneFlight, minute: number): AirborneView {
  const dest = stationByIata(a.destination);
  const from = { lat: a.lat, lon: a.lon };
  const to = dest ? { lat: dest.lat, lon: dest.lon } : from;
  const landed = a.phase === 'landed' || minute >= a.etaMinute;
  const f = Math.min(
    1,
    Math.max(0, (minute - a.positionAtMinute) / Math.max(1, a.etaMinute - a.positionAtMinute)),
  );
  const p = landed ? to : interpolateGreatCircle(from, to, f);
  return {
    flight: a.flight,
    lat: p.lat,
    lon: p.lon,
    headingDeg: landed ? a.headingDeg : bearingDeg(p, to),
    phase: landed ? 'landed' : a.etaMinute - minute <= 12 ? 'approach' : 'airborne',
    squawk: a.squawk,
    destination: a.destination,
    plannedDestination: a.plannedDestination,
    minutesToLanding: Math.max(0, Math.round(a.etaMinute - minute)),
    ...(a.commanderDecision ? { commanderDecision: a.commanderDecision } : {}),
    diverted: a.destination !== a.plannedDestination,
  };
}

export const SQUAWK_LABEL: Record<AirborneFlight['squawk'], string> = {
  normal: 'Normal',
  pan: 'PAN (urgency)',
  mayday: 'MAYDAY (distress)',
};

export const DECISION_LABEL: Record<NonNullable<AirborneFlight['commanderDecision']>, string> = {
  continue: 'continuing',
  turnback: 'turning back',
  divert: 'diverting',
};
