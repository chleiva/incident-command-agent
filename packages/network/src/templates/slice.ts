/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * A compact, relevant slice of the day's network for the Scenario Author (network-wide events such as an airspace
 * closure): the flights in the air now and those departing within the next few hours, with route, tail, phase and
 * position, filtered by region when the description names one (e.g. the UK). Deterministic and browser-safe. The
 * Author may bring only these flights into a scenario; the merge resolves every detail from here, never from the
 * model's output.
 */
import type { DaySchedule } from '../schedule';
import { flightStateAt, isAirborne, type FlightPhase } from '../state';
import { NETWORK_STATIONS, stationByIata } from '../stations';

export interface NetworkSliceFlight {
  flight: string;
  tail: string;
  type: string;
  from: string;
  to: string;
  std: string;
  sta: string;
  pax: number;
  phase: FlightPhase;
  /** Expected departure delay already in the day's plan (minutes). */
  delayMin: number;
  /** Airborne only: where it is at the slice time. */
  position?: { lat: number; lon: number };
  altitudeFt?: number;
  headingDeg?: number;
  minutesToLanding?: number;
  fuelEnduranceMin?: number;
}

export interface NetworkRegion {
  /** Plain words, e.g. "United Kingdom". */
  label: string;
  /** ISO country codes the description names (empty = the whole network). */
  countries: string[];
  /** The description names Europe as a whole: nothing is filtered out, the named countries come first. */
  wide: boolean;
}

export interface NetworkSlice {
  date: string;
  /** Slice time (ISO): the scenario's sim minute 0. */
  at: string;
  windowMin: number;
  region: NetworkRegion | null;
  flights: NetworkSliceFlight[];
  /** Flights that matched but were left out to keep the slice small. */
  truncated: number;
  /** Stations a network patch may name (diversions, spares). */
  stations: string[];
}

export const SLICE_WINDOW_MIN = 180;
export const SLICE_LIMIT = 40;

const REGION_WORDS: [RegExp, string, string][] = [
  [/\bnorthern ireland\b/g, 'GB', 'United Kingdom'],
  [
    /\b(uk|u\.k\.|united kingdom|great britain|britain|british|england|english|scotland|scottish|wales|welsh)\b/g,
    'GB',
    'United Kingdom',
  ],
  [/\b(ireland|irish)\b/g, 'IE', 'Ireland'],
  [/\b(spain|spanish|canary|canaries|balearic|balearics)\b/g, 'ES', 'Spain'],
  [/\b(france|french)\b/g, 'FR', 'France'],
  [/\b(portugal|portuguese|madeira|azores)\b/g, 'PT', 'Portugal'],
  [/\b(italy|italian)\b/g, 'IT', 'Italy'],
  [/\b(netherlands|dutch|holland)\b/g, 'NL', 'Netherlands'],
  [/\b(switzerland|swiss)\b/g, 'CH', 'Switzerland'],
  [/\b(austria|austrian)\b/g, 'AT', 'Austria'],
  [/\b(czech|czechia)\b/g, 'CZ', 'Czechia'],
  [/\b(poland|polish)\b/g, 'PL', 'Poland'],
  [/\b(denmark|danish)\b/g, 'DK', 'Denmark'],
  [/\b(jersey|channel islands)\b/g, 'JE', 'Jersey'],
];

/** The region a description names, if any (plain keyword match; the text is data, never instructions). */
export function regionFromText(text: string): NetworkRegion | null {
  let t = ` ${text.toLowerCase()} `;
  const countries: string[] = [];
  const labels: string[] = [];
  for (const [re, cc, label] of REGION_WORDS) {
    if (re.test(t)) {
      if (!countries.includes(cc)) {
        countries.push(cc);
        labels.push(label);
      }
      t = t.replace(re, ' ');
    }
    re.lastIndex = 0;
  }
  const wide = /\b(europe|european|eurocontrol|continent|continental)\b/.test(t);
  if (!countries.length && !wide) return null;
  return {
    label: [...labels, ...(wide ? ['Europe'] : [])].join(', '),
    countries,
    wide,
  };
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * The flights airborne at `atMs` or departing within `windowMin` after it (not cancelled), region-filtered, ranked:
 * the anchor aircraft's flights first, then the named region's, then airborne before departures, by time. At most
 * `limit` flights.
 */
export function networkSlice(
  schedule: DaySchedule,
  atMs: number,
  opts: { text?: string; anchorFlight?: string; windowMin?: number; limit?: number } = {},
): NetworkSlice {
  const windowMin = opts.windowMin ?? SLICE_WINDOW_MIN;
  const limit = opts.limit ?? SLICE_LIMIT;
  const region = opts.text ? regionFromText(opts.text) : null;
  const anchorTail = schedule.flights.find((f) => f.flight === opts.anchorFlight)?.tail;
  const country = (iata: string) => stationByIata(iata)?.country;
  const inRegion = (from: string, to: string) =>
    !!region?.countries.length && [country(from), country(to)].some((c) => c && region.countries.includes(c));

  const rows = schedule.flights
    .filter((f) => !f.cancelled)
    .map((f) => ({ f, st: flightStateAt(f, atMs) }))

    .filter(({ st }) => {
      if (isAirborne(st.phase)) return true;
      if (!['scheduled', 'boarding', 'taxi_out'].includes(st.phase)) return false;
      const dep = st.times.offBlockMs;
      return dep >= atMs - 15 * 60_000 && dep <= atMs + windowMin * 60_000;
    })
    .filter(
      ({ f }) =>
        !region || region.wide || !region.countries.length || inRegion(f.from, f.to) || f.tail === anchorTail,
    );

  const rank = ({ f, st }: (typeof rows)[number]) => [
    f.tail === anchorTail ? 0 : 1,
    inRegion(f.from, f.to) ? 0 : 1,
    isAirborne(st.phase) ? 0 : 1,
    st.times.offBlockMs,
  ];
  rows.sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i]! - rb[i]!;
    return a.f.flight.localeCompare(b.f.flight);
  });

  const flights = rows.slice(0, limit).map(({ f, st }): NetworkSliceFlight => {
    const air = isAirborne(st.phase);
    return {
      flight: f.flight,
      tail: f.tail,
      type: f.type,
      from: f.from,
      to: f.to,
      std: f.std,
      sta: f.sta,
      pax: f.pax,
      phase: st.phase,
      delayMin: f.delayMin,
      ...(air
        ? {
            position: { lat: round3(st.position.lat), lon: round3(st.position.lon) },
            altitudeFt: st.altitudeFt,
            headingDeg: st.headingDeg ?? 0,
            minutesToLanding: st.minutesToLanding ?? 0,
            fuelEnduranceMin: st.fuelEnduranceMin ?? 90,
          }
        : {}),
    };
  });
  return {
    date: schedule.date,
    at: new Date(atMs).toISOString().replace('.000Z', 'Z'),
    windowMin,
    region,
    flights,
    truncated: Math.max(0, rows.length - flights.length),
    stations: NETWORK_STATIONS.map((s) => s.iata),
  };
}

/** Compact text for the Author's context: one line per flight (no free text from anywhere). */
export function networkSliceText(slice: NetworkSlice): string {
  const head = [
    `Network slice at ${slice.at} (flights in the air now, and departures in the next ${Math.round(slice.windowMin / 60)} h${slice.region ? `; region named in the description: ${slice.region.label}` : ''}${slice.truncated ? `; ${slice.truncated} more not listed` : ''}):`,
    'flight | tail | type | route | phase | STD–STA (Z) | pax | position / minutes to landing',
  ];
  const lines = slice.flights.map((f) =>
    [
      f.flight,
      f.tail,
      f.type,
      `${f.from}-${f.to}`,
      f.phase,
      `${f.std.slice(11, 16)}–${f.sta.slice(11, 16)}`,
      String(f.pax),
      f.position ? `${f.position.lat},${f.position.lon} / ${f.minutesToLanding} min` : '-',
    ].join(' | '),
  );
  return [...head, ...lines, `Network stations: ${slice.stations.join(', ')}`].join('\n');
}
