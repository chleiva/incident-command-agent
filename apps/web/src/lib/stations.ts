/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Stations for the cockpit's network map: the brand pack's stations plus the live network's (task 07), so a run
 * reported on any Accent Air flight draws its airports. Alternates are added only when the run uses them.
 */
import { NETWORK_STATIONS } from '@ica/network';
import type { Station } from '@ica/schema/browser';

export function stationsForMap(brand: Station[], used: Iterable<string>): Station[] {
  const out = new Map(brand.map((s) => [s.iata, s]));
  const inPlay = new Set(used);
  for (const s of NETWORK_STATIONS) {
    if (out.has(s.iata)) continue;
    if (s.role === 'alternate' && !inPlay.has(s.iata)) continue;
    out.set(s.iata, { iata: s.iata, name: s.city, lat: s.lat, lon: s.lon, country: s.country });
  }
  return [...out.values()];
}
