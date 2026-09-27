/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * engineers — engineer roster and positioning (spec §7).
 *
 * Rules (travel time from the station distance table):
 * - Same airport: walk, 5–15 min (seeded).
 * - Drive: distance at 60 km/h + 20 min; only between mainland stations of the same country within 450 km.
 * - Fly: the next positioning flight (a Northwind rotation leg on the route departing ≥ 45 min from now, else a
 *   generated fictional positioning flight 60–150 min out) + block time + 45 min.
 * - The fastest allowed mode wins. Paging sets `paged`; `tick` moves the engineer to `travelling` and then `on_site`
 *   at the ETA. A `busy` engineer becomes `available` at `availableFromMinute`.
 */
import { getStation } from '@ica/kb';
import type { Engineer, MockSystem, Scenario, SystemMutation, SystemState, SystemStateOf } from '@ica/schema';
import { routeDistanceKm } from '../pss/index';
import { ceilTo, fail, minuteOf, randInt, updated, type Result } from '../util';

/** Island airports (no road link to the mainland). */
const ISLANDS = new Set([
  'PMI',
  'IBZ',
  'MAH',
  'TFS',
  'TFN',
  'LPA',
  'ACE',
  'FUE',
  'SPC',
  'FNC',
  'PDL',
  'TER',
  'HER',
  'CHQ',
  'RHO',
  'KGS',
  'CFU',
  'JTR',
  'JMK',
  'OLB',
  'CAG',
  'AHO',
  'PMO',
  'CTA',
  'MLA',
  'LCA',
  'PFO',
  'AJA',
  'BIA',
  'IOM',
  'JER',
  'GCI',
  'KOI',
  'LSI',
  'SYY',
]);
const NI_AIRPORTS = new Set(['BFS', 'BHD', 'LDY']);

export interface TravelPlan {
  mode: 'walk' | 'drive' | 'fly';
  etaMinute: number;
  distanceKm: number;
  detail: string;
}

function driveAllowed(from: string, to: string, d: number): boolean {
  if (ISLANDS.has(from) || ISLANDS.has(to)) return false;
  if (NI_AIRPORTS.has(from) !== NI_AIRPORTS.has(to)) return false; // Irish Sea
  const a = getStation(from);
  const b = getStation(to);
  return !!a && !!b && a.country === b.country && d <= 450;
}

/** Fastest travel option for an engineer from `from` to `to`, leaving now. */
export function travelPlan(
  scenario: Scenario | undefined,
  from: string,
  to: string,
  simMinute: number,
  rng: () => number,
): TravelPlan {
  if (from === to) {
    const walk = randInt(rng, 5, 15);
    return {
      mode: 'walk',
      etaMinute: simMinute + walk,
      distanceKm: 0,
      detail: `on airport, ${walk} min walk`,
    };
  }
  const d = routeDistanceKm(scenario, from, to);
  const options: TravelPlan[] = [];
  if (driveAllowed(from, to, d)) {
    const mins = Math.round((d / 60) * 60 + 20);
    options.push({
      mode: 'drive',
      etaMinute: simMinute + mins,
      distanceKm: d,
      detail: `drive ${d} km (${mins} min)`,
    });
  }
  const block = Math.round((d / 780) * 60 + 25);
  const leg = scenario?.world.rotation
    .filter((r) => r.from === from && r.to === to && minuteOf(scenario.startSimTime, r.std) >= simMinute + 45)
    .sort((a, b) => Date.parse(a.std) - Date.parse(b.std))[0];
  if (leg && scenario) {
    const arr = minuteOf(scenario.startSimTime, leg.sta);
    options.push({
      mode: 'fly',
      etaMinute: arr + 45,
      distanceKm: d,
      detail: `positioning on ${leg.flight} (arrives minute ${Math.round(arr)}) + 45 min`,
    });
  } else {
    const dep = ceilTo(simMinute + randInt(rng, 60, 150), 5);
    options.push({
      mode: 'fly',
      etaMinute: dep + block + 45,
      distanceKm: d,
      detail: `next positioning flight departs minute ${dep}, ${block} min block, + 45 min`,
    });
  }
  return options.sort((a, b) => a.etaMinute - b.etaMinute)[0];
}

export function seedEngineers(scenario: Scenario): SystemStateOf<'engineers'> {
  const engineers: Record<string, Engineer> = {};
  for (const e of scenario.world.engineers) {
    const busy = e.availableFromMinute > 0;
    engineers[e.id] = {
      id: e.id,
      name: e.name,
      station: e.station,
      licence: e.licence,
      skills: [...e.skills],
      status: busy ? 'busy' : 'available',
      location: e.station,
      ...(busy ? { availableFromMinute: e.availableFromMinute } : {}),
    };
  }
  return { engineers };
}

/** Page an engineer to `destination`: computes the travel plan and sets `paged`. */
export function pageEngineer(
  state: SystemState,
  scenario: Scenario | undefined,
  input: { engineerId: string; station: string },
  simMinute: number,
  rng: () => number,
): Result<{ engineer: Engineer; plan: TravelPlan }> {
  const e = state.engineers.engineers[input.engineerId];
  if (!e) return fail(`unknown engineer ${input.engineerId}`);
  if (e.status === 'busy')
    return fail(
      `${e.id} is busy${e.availableFromMinute !== undefined ? ` until minute ${e.availableFromMinute}` : ''}; page another engineer`,
    );
  if (e.status !== 'available')
    return fail(`${e.id} is already ${e.status}${e.destination ? ` to ${e.destination}` : ''}`);
  if (!getStation(input.station) && !scenario) return fail(`unknown station ${input.station}`);
  const plan = travelPlan(scenario, e.location, input.station, simMinute, rng);
  const m = updated('engineers', 'engineers', e.id, e, {
    status: 'paged',
    destination: input.station,
    etaMinute: plan.etaMinute,
    travelMode: plan.mode,
  });
  return { ok: true, value: { engineer: m.after as Engineer, plan }, mutations: [m] };
}

export function tickEngineers(state: SystemState, simMinute: number, _dtMin: number): SystemMutation[] {
  const out: SystemMutation[] = [];
  for (const e of Object.values(state.engineers.engineers)) {
    if (e.status === 'busy' && e.availableFromMinute !== undefined && simMinute >= e.availableFromMinute)
      out.push(
        updated('engineers', 'engineers', e.id, e, { status: 'available', availableFromMinute: undefined }),
      );
    else if (e.status === 'paged')
      out.push(
        updated('engineers', 'engineers', e.id, e, {
          status: 'travelling',
          location: e.travelMode === 'walk' ? e.location : 'enroute',
        }),
      );
    else if (e.status === 'travelling' && e.etaMinute !== undefined && simMinute >= e.etaMinute)
      out.push(
        updated('engineers', 'engineers', e.id, e, {
          status: 'on_site',
          location: e.destination ?? e.location,
        }),
      );
  }
  return out;
}

export const engineers: MockSystem<'engineers'> = {
  name: 'engineers',
  seed: (scenario) => seedEngineers(scenario),
  tick: tickEngineers,
  knownRefs: (state) => ({
    engineer: Object.keys(state.engineers.engineers),
    station: [...new Set(Object.values(state.engineers.engineers).map((e) => e.station))],
  }),
};
