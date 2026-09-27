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
 * - Fly: the next positioning flight (a Accent Air rotation leg on the route departing ≥ 45 min from now, else a
 *   generated fictional positioning flight 60–150 min out) + block time + 45 min.
 * - The fastest allowed mode wins. Paging sets `paged`; `tick` moves the engineer to `travelling` and then `on_site`
 *   at the ETA. A `busy` engineer becomes `available` at `availableFromMinute`.
 */
import { getStation } from '@ica/kb';
import {
  respondingEngineer,
  type Engineer,
  type MockSystem,
  type Scenario,
  type SystemMutation,
  type SystemState,
  type SystemStateOf,
} from '@ica/schema';
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

/** Engineers currently paged, travelling or on site (an active page). */
export function activeEngineers(state: SystemState): Engineer[] {
  return Object.values(state.engineers.engineers).filter(
    (e) => e.status === 'paged' || e.status === 'travelling' || e.status === 'on_site',
  );
}

/**
 * Page an engineer to `destination`: computes the travel plan and sets `paged`. An ETA delay waiting for the next
 * page (`pendingEtaDelayMin`, set by an engineer-ETA twist that fired before anyone was on the way) is added to this
 * page's ETA and cleared.
 */
export function pageEngineer(
  state: SystemState,
  scenario: Scenario | undefined,
  input: { engineerId: string; station: string; reason?: string; workOrderId?: string },
  simMinute: number,
  rng: () => number,
): Result<{ engineer: Engineer; plan: TravelPlan; delayedByMin?: number }> {
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
  const pending = Object.values(state.engineers.engineers).filter((x) => (x.pendingEtaDelayMin ?? 0) > 0);
  const delay = pending.reduce((n, x) => n + (x.pendingEtaDelayMin ?? 0), 0);
  const etaMinute = plan.etaMinute + delay;
  const m = updated('engineers', 'engineers', e.id, e, {
    status: 'paged',
    destination: input.station,
    etaMinute,
    travelMode: plan.mode,
    pagedAtMinute: Math.round(simMinute * 100) / 100,
    pageReason: input.reason?.trim() || undefined,
    workOrderId: input.workOrderId,
    pendingEtaDelayMin: undefined,
  });
  const clears = pending
    .filter((x) => x.id !== e.id)
    .map((x) => updated('engineers', 'engineers', x.id, x, { pendingEtaDelayMin: undefined }));
  const finalPlan: TravelPlan = delay
    ? { ...plan, etaMinute, detail: `${plan.detail}; held up ${delay} min (reported delay)` }
    : plan;
  return {
    ok: true,
    value: { engineer: m.after as Engineer, plan: finalPlan, ...(delay ? { delayedByMin: delay } : {}) },
    mutations: [m, ...clears],
  };
}

/**
 * The engineer-ETA twist ("the engineer on the way is held up +N min"), resolved at apply time instead of against
 * a fixed id: the named engineer when they are on the way, else THE responding engineer (assigned to a work order
 * first). With nobody on the way yet the delay waits for the next page (`pendingEtaDelayMin`); with the engineer
 * already on site it no longer applies. Every outcome returns a plain-language note: never a silent skip.
 */
export function delayEngineerEta(
  state: SystemState,
  namedId: string,
  minutes: number,
  simMinute: number,
): { mutations: SystemMutation[]; note: string } | { error: string } {
  const ahead = (e: Engineer | undefined): e is Engineer =>
    !!e &&
    (e.status === 'paged' || e.status === 'travelling') &&
    typeof e.etaMinute === 'number' &&
    e.etaMinute > simMinute;
  const named = state.engineers.engineers[namedId];
  const target = ahead(named) ? named : respondingEngineer(state, { statuses: ['paged', 'travelling'] });
  if (ahead(target)) {
    const eta = target.etaMinute!;
    const m = updated('engineers', 'engineers', target.id, target, { etaMinute: eta + minutes });
    return {
      mutations: [m],
      note: `Engineer ${target.name} (${target.id}) is held up: ETA minute ${Math.round(eta)} → ${Math.round(eta + minutes)}.`,
    };
  }
  const onSite = respondingEngineer(state, { statuses: ['on_site'] });
  if (onSite)
    return {
      mutations: [],
      note: `The reported ${minutes}-minute engineer delay no longer applies: ${onSite.name} (${onSite.id}) is already on site.`,
    };
  const holder = named ?? Object.values(state.engineers.engineers)[0];
  if (!holder) return { error: 'engineer delay: no engineers in this run' };
  const m = updated('engineers', 'engineers', holder.id, holder, {
    pendingEtaDelayMin: (holder.pendingEtaDelayMin ?? 0) + minutes,
  });
  return {
    mutations: [m],
    note: `No engineer is on the way yet: the next engineer paged will arrive ${minutes} min later than their normal travel time.`,
  };
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
