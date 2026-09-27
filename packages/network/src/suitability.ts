/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Candidate airports near a position, ranked by distance and ground-side suitability (runway, fire cover,
 * handling, engineering, hotels, curfew). **Options only**: the commander decides whether and where to divert;
 * this ranking is prepared for the commander's consideration and for the ground-side response.
 */
import { haversineKm, type LatLon } from './geo';
import { type NetworkAircraftType } from './schedule';
import { AIRPORT_CAPABILITIES, stationByIata, type AirportCapability } from './stations';

export const OPTIONS_ONLY_NOTE =
  "Options for the commander's consideration only. The commander decides whether and where to divert; the ground team prepares whichever airport is chosen.";

/** Minimum runway length (m) used for the simulation's screen; illustrative, not performance data. */
export const MIN_RUNWAY_M: Record<NetworkAircraftType, number> = { A319: 1800, A320: 2000, A321: 2200 };
/** Minimum RFFS category for the A320 family (illustrative). */
export const MIN_RFFS_CAT = 7;

export interface SuitabilityFilters {
  /** Ignore candidates further than this (default 900 km). */
  maxDistanceKm?: number;
  /** Airports to leave out (e.g. the departure airport when turning back is being ranked separately). */
  exclude?: string[];
  /** Local time (ms) for curfew and opening-hours checks; omitted = not checked. */
  atMs?: number;
  /** Maximum results (default 5). */
  limit?: number;
}

export interface SuitableAirport {
  iata: string;
  name: string;
  city: string;
  distanceKm: number;
  /** Rough time to the airport at ~780 km/h plus 15 min for the approach. */
  etaMin: number;
  suitable: boolean;
  /** Lower is better: distance plus ground-side penalties (km-equivalent). */
  score: number;
  reasons: string[];
  capability: AirportCapability;
}

function localMinuteOfDay(atMs: number, offsetMin: number): number {
  const d = new Date(atMs + offsetMin * 60_000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

function hm(s: string): number {
  const [h, m] = s.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

function inWindow(min: number, from: string, to: string): boolean {
  const a = hm(from);
  const b = hm(to);
  return a <= b ? min >= a && min < b : min >= a || min < b;
}

export function suitableAirports(
  position: LatLon,
  aircraftType: NetworkAircraftType,
  filters: SuitabilityFilters = {},
): SuitableAirport[] {
  const maxKm = filters.maxDistanceKm ?? 900;
  const exclude = new Set(filters.exclude ?? []);
  const out: SuitableAirport[] = [];
  for (const cap of AIRPORT_CAPABILITIES) {
    if (exclude.has(cap.iata)) continue;
    const st = stationByIata(cap.iata);
    if (!st) continue;
    const distanceKm = Math.round(haversineKm(position, st));
    if (distanceKm > maxKm) continue;
    const reasons: string[] = [];
    let suitable = true;
    let penalty = 0;
    if (cap.runwayM < MIN_RUNWAY_M[aircraftType]) {
      suitable = false;
      reasons.push(`runway ${cap.runwayM} m is short for an ${aircraftType}`);
    }
    if (cap.rffsCat < MIN_RFFS_CAT) {
      suitable = false;
      reasons.push(`fire cover category ${cap.rffsCat} is below ${MIN_RFFS_CAT}`);
    }
    if (filters.atMs !== undefined) {
      const local = localMinuteOfDay(filters.atMs, st.utcStdOffsetMin);
      if (cap.curfew && inWindow(local, cap.curfew.fromLocal, cap.curfew.toLocal)) {
        suitable = false;
        reasons.push(`night curfew ${cap.curfew.fromLocal}–${cap.curfew.toLocal}`);
      }
      if (cap.openHours !== '24h') {
        const [from, to] = cap.openHours.split('–') as [string, string];
        if (!inWindow(local, from, to)) {
          suitable = false;
          reasons.push(`closed (open ${cap.openHours})`);
        }
      }
    }
    if (cap.handlingContract) reasons.push('Accent Air handling contract');
    else {
      penalty += 150;
      reasons.push('no handling contract (ad-hoc handling needed)');
    }
    if (cap.engineering === 'own') reasons.push('Accent Air engineers on station');
    else if (cap.engineering === 'contract') {
      penalty += 40;
      reasons.push('contract engineering cover');
    } else {
      penalty += 120;
      reasons.push('no engineering cover (engineer would travel)');
    }
    if (cap.hotelRooms < 150) {
      penalty += 40;
      reasons.push(`limited hotel capacity (~${cap.hotelRooms} rooms)`);
    }
    out.push({
      iata: cap.iata,
      name: st.name,
      city: st.city,
      distanceKm,
      etaMin: Math.round((distanceKm / 780) * 60 + 15),
      suitable,
      score: distanceKm + penalty + (suitable ? 0 : 10_000),
      reasons,
      capability: cap,
    });
  }
  out.sort((a, b) => a.score - b.score || a.distanceKm - b.distanceKm);
  return out.slice(0, filters.limit ?? 5);
}
