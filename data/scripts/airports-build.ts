/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * npm run airports:build — downloads OurAirports airports.csv (public domain) and writes data/airports/stations.json:
 * European large and medium airports with an IATA code, plus every station used by the shipped scenarios.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'csv-parse/sync';
import { USER_AGENT, stdOffsetFor, writePrettyJson } from './lib';

const SRC = 'https://ourairports.com/data/airports.csv';
const OUT = fileURLToPath(new URL('../airports/stations.json', import.meta.url));
const SCENARIOS = fileURLToPath(new URL('../../scenarios/public/', import.meta.url));

function scenarioStations(): Set<string> {
  const out = new Set<string>();
  let files: string[] = [];
  try {
    files = readdirSync(SCENARIOS).filter((f) => f.endsWith('.json'));
  } catch {
    return out;
  }
  for (const f of files) {
    const text = readFileSync(SCENARIOS + f, 'utf8');
    for (const m of text.matchAll(/"(?:station|from|to)"\s*:\s*"([A-Z]{3})"/g)) out.add(m[1]);
  }
  return out;
}

async function main() {
  console.log(`downloading ${SRC}`);
  const res = await fetch(SRC, { headers: { 'user-agent': USER_AGENT } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const csv = await res.text();
  const rows = parse(csv, { columns: true, skip_empty_lines: true }) as Record<string, string>[];
  const wanted = scenarioStations();
  // Always include the carrier's network stations used in the fixtures, even before scenarios exist.
  for (const s of ['MAN', 'DUB', 'LGW', 'BRS', 'EDI', 'GLA', 'BHX', 'PMI', 'FAO', 'AGP', 'ALC', 'TFS', 'LPA'])
    wanted.add(s);
  const stations = rows
    .filter((r) => r.iata_code && /^[A-Z]{3}$/.test(r.iata_code))
    .filter(
      (r) =>
        (r.continent === 'EU' &&
          (r.type === 'large_airport' || r.type === 'medium_airport') &&
          r.scheduled_service === 'yes') ||
        wanted.has(r.iata_code),
    )
    .filter((r) => r.type !== 'closed')
    .map((r) => ({
      iata: r.iata_code,
      icao: r.icao_code || r.gps_code || undefined,
      name: r.name,
      lat: Math.round(Number(r.latitude_deg) * 1e5) / 1e5,
      lon: Math.round(Number(r.longitude_deg) * 1e5) / 1e5,
      country: r.iso_country,
      region: r.iso_region,
      type: r.type,
      utcStdOffsetMin: stdOffsetFor(r.iso_country, r.iso_region),
    }));
  // De-duplicate on IATA, preferring large airports.
  const byIata = new Map<string, (typeof stations)[number]>();
  const rank = (t: string) => (t === 'large_airport' ? 0 : t === 'medium_airport' ? 1 : 2);
  for (const s of stations) {
    const prev = byIata.get(s.iata);
    if (!prev || rank(s.type) < rank(prev.type)) byIata.set(s.iata, s);
  }
  const list = [...byIata.values()].sort((a, b) => a.iata.localeCompare(b.iata));
  const missing = [...wanted].filter((w) => !byIata.has(w));
  if (missing.length) console.warn(`! stations not found in OurAirports: ${missing.join(', ')}`);
  await writePrettyJson(OUT, {
    source: SRC,
    licence: 'Public domain (The Unlicense), OurAirports',
    retrievedAt: new Date().toISOString().slice(0, 10),
    stations: list.map(({ type: _type, ...s }) => s),
  });
  console.log(`wrote ${list.length} stations to ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
