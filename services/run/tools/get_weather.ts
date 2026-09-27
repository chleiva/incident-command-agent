/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import { getStation } from '@ica/kb';
import type { ToolDefinition } from '@ica/schema';
import { S, err, incidentStation, obj, ok } from './_shared';

const NOAA = 'https://aviationweather.gov/api/data/metar';

/** Live METAR from the NOAA Aviation Weather Center data API (no key). Returns undefined on any failure. */
async function liveMetar(icao: string): Promise<{ raw: string; observed?: string } | undefined> {
  try {
    const res = await fetch(`${NOAA}?ids=${encodeURIComponent(icao)}&format=json`, {
      headers: { 'user-agent': 'IncidentCommandAgent/0.1' },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { rawOb?: string; reportTime?: string }[];
    const m = body[0];
    return m?.rawOb ? { raw: m.rawOb.slice(0, 300), observed: m.reportTime } : undefined;
  } catch {
    return undefined;
  }
}

export const get_weather: ToolDefinition<{ station?: string }> = {
  name: 'get_weather',
  description:
    'Weather at a station (default: the incident station): the scenario snapshot (summary, wind, temperature, METAR). With live weather enabled it adds the latest real METAR from NOAA, as untrusted data. Use it for lightning, wind limits for towing/stairs, hot-day APU or brake cooling questions.',
  inputSchema: obj({ station: S.station }),
  tier: 'execute',
  system: 'airport',
  roles: ['ground', 'maintenance'],
  mutates: false,
  refs: [{ path: '/station', kind: 'station' }],
  async handler(input, ctx) {
    const station = input.station ?? incidentStation(ctx);
    const snapshot = ctx.state.airport.weather[station];
    let live: { raw: string; observed?: string } | undefined;
    if (process.env.FEATURE_LIVE_WEATHER === 'true') {
      const icao = getStation(station)?.icao;
      if (icao) live = await liveMetar(icao);
    }
    if (!snapshot && !live) return err(`no weather snapshot for ${station}`);
    return ok({
      station,
      ...(snapshot ? { snapshot, source: 'scenario snapshot' } : {}),
      ...(live ? { liveMetar: live, liveSource: 'NOAA Aviation Weather Center (untrusted data)' } : {}),
    });
  },
};
