/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * `GET /config` (AppConfig): brand pack, feature flags, stations and limits.
 *
 * In Lambda the brand pack and the stations list are compiled in at synth time (esbuild `define` of
 * `process.env.BRAND_PACK` / `process.env.STATIONS_JSON`, see infra) because Lambda env is capped at 4 KB. Locally
 * they are read from `config/brand.local.json` → `config/brand.default.json` and `data/airports/stations.json`.
 */
import {
  BrandPackSchema,
  StationSchema,
  compileSchema,
  type AppConfig,
  type BrandPack,
  type Station,
} from '@ica/schema';
import { Type } from '@sinclair/typebox';
import { SPEED_MAX, SPEED_MIN, type ApiSettings } from './settings';

/** Public-domain airport reference data (OurAirports) for the default brand stations: a fallback only. */
export const FALLBACK_STATIONS: Station[] = [
  { iata: 'MAN', name: 'Manchester Airport', lat: 53.3537, lon: -2.275, country: 'GB' },
  { iata: 'PMI', name: 'Palma de Mallorca Airport', lat: 39.5517, lon: 2.7388, country: 'ES' },
  { iata: 'EDI', name: 'Edinburgh Airport', lat: 55.95, lon: -3.3725, country: 'GB' },
  { iata: 'FAO', name: 'Faro Airport', lat: 37.0144, lon: -7.9659, country: 'PT' },
  { iata: 'AGP', name: 'Málaga-Costa del Sol Airport', lat: 36.6749, lon: -4.4991, country: 'ES' },
  { iata: 'DUB', name: 'Dublin Airport', lat: 53.4213, lon: -6.2701, country: 'IE' },
  { iata: 'ALC', name: 'Alicante-Elche Airport', lat: 38.2822, lon: -0.5582, country: 'ES' },
  { iata: 'TFS', name: 'Tenerife South Airport', lat: 28.0445, lon: -16.5725, country: 'ES' },
  { iata: 'LGW', name: 'London Gatwick Airport', lat: 51.1481, lon: -0.1903, country: 'GB' },
  { iata: 'AMS', name: 'Amsterdam Airport Schiphol', lat: 52.3086, lon: 4.7639, country: 'NL' },
  { iata: 'CDG', name: 'Paris Charles de Gaulle Airport', lat: 49.0097, lon: 2.5479, country: 'FR' },
  { iata: 'BCN', name: 'Barcelona-El Prat Airport', lat: 41.2971, lon: 2.0785, country: 'ES' },
];

export const DEFAULT_BRAND: BrandPack = {
  productName: 'Ground Incident Coordination Agent',
  carrierName: 'Northwind Air',
  carrierCode: 'NWD',
  colours: { primary: '#1F3A5F', accent: '#4F8FBF' },
  stations: FALLBACK_STATIONS.map((s) => s.iata),
  disclaimer: 'Simulated systems · fictional carrier',
};

const validateBrand = compileSchema(BrandPackSchema);
const validateStations = compileSchema(Type.Array(StationSchema));

/** Parse a brand pack JSON string; throws with the schema errors when invalid. */
export function parseBrandPack(raw: string): BrandPack {
  const r = validateBrand(JSON.parse(raw));
  if (!r.ok) throw new Error(`invalid brand pack: ${r.errors.join('; ')}`);
  return r.value;
}

/**
 * Parse a stations list. Accepts `Station[]` or `{stations: Station[]}`; tolerates extra fields per entry by
 * picking the contract fields (the airports pipeline may add more).
 */
export function parseStations(raw: string): Station[] {
  const parsed: unknown = JSON.parse(raw);
  const list = Array.isArray(parsed) ? parsed : (parsed as { stations?: unknown })?.stations;
  if (!Array.isArray(list)) throw new Error('invalid stations: expected an array');
  const picked = list.map((s: Record<string, unknown>) => ({
    iata: s.iata,
    name: s.name,
    lat: s.lat,
    lon: s.lon,
    country: s.country,
  }));
  const r = validateStations(picked);
  if (!r.ok) throw new Error(`invalid stations: ${r.errors.slice(0, 5).join('; ')}`);
  return r.value;
}

/** The brand's stations plus every scenario station, in brand order then alphabetical; unknown codes dropped. */
export function selectStations(all: Station[], brand: BrandPack, scenarioStations: string[]): Station[] {
  const byCode = new Map(all.map((s) => [s.iata, s]));
  for (const s of FALLBACK_STATIONS) if (!byCode.has(s.iata)) byCode.set(s.iata, s);
  const out: Station[] = [];
  const seen = new Set<string>();
  const add = (code: string) => {
    const s = byCode.get(code);
    if (s && !seen.has(code)) {
      seen.add(code);
      out.push(s);
    }
  };
  brand.stations.forEach(add);
  [...new Set(scenarioStations)].sort().forEach(add);
  return out;
}

export function buildAppConfig(input: {
  brand: BrandPack;
  stations: Station[];
  scenarioStations: string[];
  settings: ApiSettings;
}): AppConfig {
  const { settings } = input;
  return {
    brand: input.brand,
    features: settings.features,
    stations: selectStations(input.stations, input.brand, input.scenarioStations),
    limits: {
      maxRunsPerDay: settings.maxRunsPerDay,
      runBudgetUsd: settings.llm.limits.budgetUsd,
      horizonMin: settings.llm.limits.horizonMin,
      speedMin: SPEED_MIN,
      speedMax: SPEED_MAX,
    },
  };
}
