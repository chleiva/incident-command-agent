/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import { getStation, stations } from '@ica/kb';
import type { ToolDefinition } from '@ica/schema';
import { obj, ok } from './_shared';

export const lookup_airport: ToolDefinition<{ query: string }> = {
  name: 'lookup_airport',
  description:
    'Look up a real airport by IATA code or by name/city fragment (European large and medium airports plus the scenario stations; OurAirports data). Returns up to 5 matches with IATA, ICAO, name, country and coordinates.',
  inputSchema: obj({ query: { type: 'string', minLength: 2, maxLength: 60 } }, ['query']),
  tier: 'execute',
  system: 'knowledge',
  roles: ['author'],
  mutates: false,
  async handler({ query }) {
    const q = query.trim();
    const exact = /^[A-Za-z]{3}$/.test(q) ? getStation(q.toUpperCase()) : undefined;
    const lower = q.toLowerCase();
    const matches = exact
      ? [exact]
      : stations
          .filter((s) => s.name.toLowerCase().includes(lower) || s.icao?.toLowerCase() === lower)
          .slice(0, 5);
    return ok({
      matches: matches.map(({ iata, icao, name, country, lat, lon }) => ({
        iata,
        icao,
        name,
        country,
        lat,
        lon,
      })),
    });
  },
};
