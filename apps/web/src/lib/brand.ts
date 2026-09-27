/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Brand pack defaults (FR-11): the fictional carrier. Mirrors `config/brand.default.json` (a test keeps them in
 * sync) and adds station coordinates for the equal-area network map.
 */
import type { AppConfig, BrandPack, Station } from '@ica/schema/browser';

/** The product name (task 06 §1.1). The package scope, stack ids, repo and table names keep "ica". */
export const PRODUCT_NAME = 'Incident Coordination Agent';

/** The About dialog's credit (owner request, task 08): used when the brand pack has no `about`. */
export const DEFAULT_ABOUT: NonNullable<BrandPack['about']> = {
  author: 'Chris Beltran',
  authorUrl: 'https://www.linkedin.com/in/chris-ai/',
  repoUrl: 'https://github.com/chleiva/incident-command-agent',
};

export const DEFAULT_BRAND: BrandPack = {
  productName: PRODUCT_NAME,
  carrierName: 'Accent Air',
  carrierCode: 'ACX',
  colours: { primary: '#1F3A5F', accent: '#4F8FBF' },
  stations: ['MAN', 'PMI', 'EDI', 'FAO', 'AGP', 'DUB', 'ALC', 'TFS', 'LGW', 'AMS', 'CDG', 'BCN'],
  disclaimer: 'Simulated systems · fictional carrier',
  about: DEFAULT_ABOUT,
};

/** Public airport reference points (approximate aerodrome coordinates). */
export const DEFAULT_STATIONS: Station[] = [
  { iata: 'MAN', name: 'Manchester', lat: 53.365, lon: -2.273, country: 'GB' },
  { iata: 'PMI', name: 'Palma de Mallorca', lat: 39.552, lon: 2.739, country: 'ES' },
  { iata: 'EDI', name: 'Edinburgh', lat: 55.95, lon: -3.373, country: 'GB' },
  { iata: 'FAO', name: 'Faro', lat: 37.014, lon: -7.966, country: 'PT' },
  { iata: 'AGP', name: 'Málaga', lat: 36.675, lon: -4.499, country: 'ES' },
  { iata: 'DUB', name: 'Dublin', lat: 53.421, lon: -6.27, country: 'IE' },
  { iata: 'ALC', name: 'Alicante', lat: 38.282, lon: -0.558, country: 'ES' },
  { iata: 'TFS', name: 'Tenerife South', lat: 28.044, lon: -16.573, country: 'ES' },
  { iata: 'LGW', name: 'London Gatwick', lat: 51.148, lon: -0.19, country: 'GB' },
  { iata: 'AMS', name: 'Amsterdam', lat: 52.31, lon: 4.768, country: 'NL' },
  { iata: 'CDG', name: 'Paris Charles de Gaulle', lat: 49.01, lon: 2.548, country: 'FR' },
  { iata: 'BCN', name: 'Barcelona', lat: 41.297, lon: 2.078, country: 'ES' },
];

export const DEFAULT_APP_CONFIG: AppConfig = {
  brand: DEFAULT_BRAND,
  features: { webSearch: false, liveWeather: false, narrator: true, sideBySide: true },
  stations: DEFAULT_STATIONS,
  limits: { maxRunsPerDay: 20, runBudgetUsd: 2, horizonMin: 180, speedMin: 1, speedMax: 30 },
};

/** Merge a (possibly partial) server config over the defaults so the UI never renders without a brand. */
export function withDefaults(config: Partial<AppConfig> | null | undefined): AppConfig {
  if (!config) return DEFAULT_APP_CONFIG;
  return {
    brand: {
      ...DEFAULT_BRAND,
      ...(config.brand ?? {}),
      productName: config.brand?.productName ?? PRODUCT_NAME,
      about: { ...DEFAULT_ABOUT, ...(config.brand?.about ?? {}) },
    },
    features: { ...DEFAULT_APP_CONFIG.features, ...(config.features ?? {}) },
    stations: config.stations?.length ? config.stations : DEFAULT_STATIONS,
    limits: { ...DEFAULT_APP_CONFIG.limits, ...(config.limits ?? {}) },
  };
}

const HEX = /^#[0-9a-fA-F]{6}$/;

/** Map the brand colour pair onto the identity tokens (never onto the four semantic accents). */
export function applyBrand(brand: BrandPack, root: HTMLElement = document.documentElement): void {
  const set = (name: string, hex: string) => {
    if (!HEX.test(hex)) return;
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    root.style.setProperty(`--c-${name}`, `${r} ${g} ${b}`);
    root.style.setProperty(`--color-${name}`, hex);
  };
  set('brand-primary', brand.colours.primary);
  set('brand-accent', brand.colours.accent);
  document.title = `${brand.productName ?? PRODUCT_NAME} · ${brand.carrierName}`;
}

/**
 * The always-visible "Simulated systems" badge text (task 06 §1.8): a brand's own disclaimer is kept, but it must
 * say "Simulated systems".
 */
export function simulatedLabel(disclaimer: string | undefined): string {
  const d = (disclaimer ?? '').trim();
  if (!d) return 'Simulated systems · fictional carrier';
  return /simulated systems/i.test(d) ? d : `Simulated systems · ${d}`;
}
