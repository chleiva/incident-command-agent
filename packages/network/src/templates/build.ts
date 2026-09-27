/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Flight → scenario: `buildScenarioFromFlight` moves the incident type's template (a shipped scenario family) onto a
 * flight from the live network, deterministically and for free:
 * - the aircraft, its remaining sectors and the day's rotation come from the schedule (tail, type, times, pax);
 * - stations: the template's incident station becomes the flight's incident station, the template's home base
 *   becomes the tail's base, and other stations (e.g. where a nearby engineer is) become the nearest real airports;
 * - spares and other aircraft get fresh fictional tails; other tails' legs get fresh flight numbers;
 * - the operating crew's report time and FDP limit come from the day's duty; cohorts are scaled to the booked pax;
 * - trigger, evidence, twists (incl. the engineer-ETA twist), baseline chronology and expectations are the
 *   template's, remapped; clock times shift with the scenario.
 * The result validates against the scenario schema (tests check every flight × applicable type).
 */
import type { RotationLeg, Scenario, Sector } from '@ica/schema/browser';

type Cohort = Scenario['world']['cohorts'][number];
import { bearingDeg, haversineKm } from '../geo';
import { crewFor } from '../network';
import type { DaySchedule, NetworkFlight } from '../schedule';
import { NETWORK_STATIONS, stationByIata } from '../stations';
import { arrivalFor, incidentContext, incidentTypesFor, type FlightIncidentContext } from './context';
import { flightStateAt, isAirborne } from '../state';
import { incidentTypeById, type IncidentType } from './incidentTypes';
import { templateScenario } from './library';
import { createRemapper, dedupeStringArrays, type RemapSpec } from './remap';

export interface BuildOptions {
  /** Network time of the report (decides the flight's phase). Default: the flight's STD. */
  atMs?: number;
  /** Use this scenario as the template instead of the type's (e.g. a recorded run's scenario in mock mode). */
  template?: Scenario;
  /** Skip the phase/station applicability check (tests, mock recordings). */
  force?: boolean;
}

export interface BuiltScenario {
  scenario: Scenario;
  type: IncidentType;
  context: FlightIncidentContext;
  /** Apply the same remapping to anything recorded against the template (mock-mode recordings). */
  remap: <T>(v: T) => T;
  /** One-line preview for the report dialog. */
  preview: { trigger: string; facts: string[]; twists: string[] };
}

export class TemplateError extends Error {
  constructor(
    message: string,
    readonly code: 'flight_not_found' | 'unknown_type' | 'not_applicable' | 'no_template',
  ) {
    super(message);
    this.name = 'TemplateError';
  }
}

const iso = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z');
const hhmm = (ms: number) => iso(ms).slice(11, 16);
const CITY_ALIASES: Record<string, string[]> = { AGP: ['Malaga'], TFS: ['Tenerife'] };
const HOME = 'MAN';
const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** Recompute the commander-decision twist for the flight: where it is at the decision minute and its new ETA. */
function airborneTwists(
  twists: Scenario['twists'],
  flight: NetworkFlight,
  S: string,
  startMs: number,
): Scenario['twists'] {
  return twists.map((tw) => {
    if (tw.id !== 'tw-commander-decision') return tw;
    const m = tw.atMinute ?? 2;
    const st = flightStateAt(flight, startMs + m * 60_000);
    const dest = stationByIata(S)!;
    const eta = m + Math.max(8, Math.round((haversineKm(st.position, dest) / 780) * 60 + 10));
    return {
      ...tw,
      effects: tw.effects.map((e) =>
        e.op === 'patch' && e.system === 'occ' && e.entity === 'airborne'
          ? {
              ...e,
              id: flight.flight,
              patch: {
                ...e.patch,
                destination: S,
                etaMinute: eta,
                lat: round3(st.position.lat),
                lon: round3(st.position.lon),
                positionAtMinute: m,
                headingDeg: Math.round(bearingDeg(st.position, dest)),
              },
            }
          : e,
      ),
    };
  });
}

/** Airborne: keep baseline steps only for flights the aircraft still has to fly (drop steps left with none). */
function keepFlights(steps: Scenario['baseline'], later: NetworkFlight[]): Scenario['baseline'] {
  const ok = new Set(later.map((l) => l.flight));
  return steps.flatMap((st) => {
    const args = { ...st.action.args };
    if (Array.isArray(args.flights)) {
      args.flights = (args.flights as string[]).filter((f) => ok.has(f));
      if ((args.flights as string[]).length === 0) return [];
    }
    if (
      typeof args.flight === 'string' &&
      st.action.tool !== 'notify_destination_station' &&
      !ok.has(args.flight)
    )
      return [];
    return [{ ...st, action: { ...st.action, args } }];
  });
}

function sectorOf(f: NetworkFlight): Sector {
  return { flight: f.flight, from: f.from, to: f.to, std: f.std, pax: f.pax, distanceKm: f.distanceKm };
}

function legOf(f: NetworkFlight): RotationLeg {
  return { flight: f.flight, tail: f.tail, from: f.from, to: f.to, std: f.std, sta: f.sta, pax: f.pax };
}

const NARRATIVE: Record<string, (c: NarrativeCtx) => string> = {
  's01-pushback-tug-contact': (c) =>
    `${c.city}, ${c.time}Z. Accent Air ${c.flight} to ${c.dest}, an ${c.type} (${c.tail}) with ${c.pax} passengers, is being pushed back when the towbar shear pin fails and the tug contacts the nose landing gear. No one is hurt; the captain sets the parking brake, shuts down and asks for engineering. ${c.more}`,
  's02-catering-truck-door-strike': (c) =>
    `${c.city}, ${c.time}Z. While ${c.tail} (${c.type}) is being turned round for Accent Air ${c.flight} to ${c.dest}, the catering truck strikes the forward service door. ${c.pax} passengers are booked. Engineering cover on station is limited. ${c.more}`,
  's03-bird-strike-inspection': (c) =>
    `${c.city}, ${c.time}Z. ${c.tail} (${c.type}) has just arrived${c.inbound ? ` as ${c.inbound}` : ''}; the walk-round finds bird remains on the nose and around an engine inlet. The next sector, Accent Air ${c.flight} to ${c.dest}, is due at ${c.std}Z with ${c.pax} passengers booked. ${c.more}`,
  's04-lightning-strike-outstation': (c) =>
    `${c.city}, ${c.time}Z. ${c.tail} (${c.type}) reports a lightning strike on approach into ${c.city} and parks on stand. The return, Accent Air ${c.flight} to ${c.dest}, has ${c.pax} passengers booked. Accent Air has no licensed engineer at ${c.city}. ${c.more}`,
  's05-cargo-door-warning': (c) =>
    `${c.city}, ${c.time}Z. During boarding of Accent Air ${c.flight} to ${c.dest} (${c.tail}, ${c.type}), the flight deck gets an aft cargo door warning that will not clear. ${c.pax} passengers are booked. ${c.more}`,
  's06-apu-inop-deferral-temptation': (c) =>
    `${c.city}, ${c.time}Z. Before Accent Air ${c.flight} to ${c.dest}, the crew report that the APU of ${c.tail} (${c.type}) will not start. It is a hot day, ${c.pax} passengers are booked and the handler is pressing for a quick answer. ${c.more}`,
  's07-slide-inadvertent-deployment': (c) =>
    `${c.city}, ${c.time}Z. During boarding of Accent Air ${c.flight} to ${c.dest} (${c.tail}, ${c.type}), a door escape slide inflates on stand. No one is hurt. ${c.pax} passengers are booked, including passengers who need assistance. ${c.more}`,
  's08-hydraulic-leak-on-stand': (c) =>
    `${c.city}, ${c.time}Z. On the walk-round of ${c.tail} (${c.type}) before Accent Air ${c.flight} to ${c.dest}, a hydraulic leak is spotted near the main landing gear. ${c.pax} passengers are booked and the stand is needed for an inbound flight. ${c.more}`,
  's09-fuel-spill-at-stand': (c) =>
    `${c.city}, ${c.time}Z. Fuel spills on the stand while ${c.tail} (${c.type}) is refuelled for Accent Air ${c.flight} to ${c.dest}. Refuelling stops and the fire service attends. ${c.pax} passengers are booked. ${c.more}`,
  's10-brake-overheat-fdp-squeeze': (c) =>
    `${c.city}, ${c.time}Z. ${c.tail} (${c.type}) arrives with a brake overheat indication; the brakes must cool before anyone can inspect them. The return, Accent Air ${c.flight} to ${c.dest}, has ${c.pax} passengers booked, and the crew's duty margin is tight. ${c.more}`,
  's11-air-turnback-bird-strike': (c) =>
    `${c.time}Z. Accent Air ${c.flight} to ${c.dest}, an ${c.type} (${c.tail}) with ${c.pax} passengers, hits birds on the climb; engine vibration rises and the crew declare PAN. The commander returns to ${c.city} and expects an overweight landing. The commander flies and decides the aircraft; the agents prepare the ground. ${c.more}`,
  's12-diversion-smoke-fumes': (c) =>
    `${c.time}Z. On Accent Air ${c.flight} to ${c.dest}, an ${c.type} (${c.tail}) with ${c.pax} passengers, the cabin crew report an acrid smell and light fumes; the crew declare PAN and the commander diverts to ${c.city}. The commander flies and decides the aircraft; the agents prepare the ground. ${c.more}`,
  's13-diversion-medical': (c) =>
    `${c.time}Z. On Accent Air ${c.flight} to ${c.dest}, an ${c.type} (${c.tail}) with ${c.pax} passengers, a passenger collapses; a doctor on board advises landing as soon as possible and the commander diverts to ${c.city}. The commander flies and decides the aircraft; the agents prepare the ground. ${c.more}`,
  's14-engine-shutdown-overweight-landing': (c) =>
    `${c.time}Z. On Accent Air ${c.flight} to ${c.dest}, an ${c.type} (${c.tail}) with ${c.pax} passengers, an engine loses oil pressure and the crew shut it down. The commander returns to ${c.city} and will land overweight. The commander flies and decides the aircraft; the agents prepare the ground. ${c.more}`,
  's15-diversion-disruptive-passenger': (c) =>
    `${c.time}Z. On Accent Air ${c.flight} to ${c.dest}, an ${c.type} (${c.tail}) with ${c.pax} passengers, an intoxicated passenger becomes aggressive and is restrained. The commander diverts to ${c.city} and asks for police to meet the aircraft. The commander flies and decides the aircraft; the agents prepare the ground. ${c.more}`,
};

interface NarrativeCtx {
  city: string;
  time: string;
  flight: string;
  dest: string;
  type: string;
  tail: string;
  pax: number;
  std: string;
  inbound?: string;
  more: string;
}

function freshTails(schedule: DaySchedule, count: number, taken: Set<string>): string[] {
  const used = new Set([...schedule.tails.map((t) => t.tail), ...taken]);
  const out: string[] = [];
  const L = 'ABCDEFGHJKLMNPRSTUVWXYZ';
  for (const a of 'SQZ')
    for (const b of L)
      for (const c of L) {
        if (out.length >= count) return out;
        const t = `AX-${a}${b}${c}`;
        if (!used.has(t)) {
          used.add(t);
          out.push(t);
        }
      }
  return out;
}

function freshFlights(schedule: DaySchedule, count: number): string[] {
  const used = new Set(schedule.flights.map((f) => f.flight));
  const out: string[] = [];
  for (let n = 999; n >= 100 && out.length < count; n--) if (!used.has(`ACX${n}`)) out.push(`ACX${n}`);
  return out;
}

/** Station codes the template uses, other than its incident station and home base. */
function otherStations(t: Scenario): string[] {
  const text = JSON.stringify(t);
  const codes = new Set(text.match(/(?<![A-Za-z0-9])[A-Z]{3}(?![A-Za-z0-9])/g) ?? []);
  return [...codes].filter((c) => c !== t.aircraft.station && c !== HOME && stationByIata(c));
}

export function buildScenarioFromFlight(
  schedule: DaySchedule,
  flightId: string,
  typeId: string,
  opts: BuildOptions = {},
): BuiltScenario {
  const flight = schedule.flights.find((f) => f.flight === flightId);
  if (!flight)
    throw new TemplateError(`flight ${flightId} is not in the ${schedule.date} schedule`, 'flight_not_found');
  const type = incidentTypeById(typeId);
  if (!type) throw new TemplateError(`unknown incident type '${typeId}'`, 'unknown_type');
  const ctx = incidentContext(schedule, flightId, opts.atMs ?? flight.stdMs)!;
  if (!opts.force) {
    const option = incidentTypesFor(ctx).find((o) => o.type.id === type.id);
    if (!option)
      throw new TemplateError(
        `${type.label} does not apply while the flight is ${ctx.phase}`,
        'not_applicable',
      );
    if (!option.enabled) throw new TemplateError(option.reason ?? 'not available', 'not_applicable');
  }
  const t0 = opts.template ?? templateScenario(type.template);
  if (!t0) throw new TemplateError(`no template for ${type.id}`, 'no_template');
  const T = structuredClone(t0);
  // Airborne templates anchor on the flight in the air; ground templates on the first affected departure.
  const air = !!T.airborne;
  if (!air && ctx.nextSectors.length === 0)
    throw new TemplateError('no further flights on this aircraft today', 'not_applicable');
  const airState = air ? flightStateAt(flight, ctx.atMs) : undefined;
  if (air && !isAirborne(airState!.phase))
    throw new TemplateError('the aircraft is not in the air', 'not_applicable');

  const S = air ? (arrivalFor(type, ctx) ?? flight.from) : ctx.station;
  const B = ctx.tail.base;
  const nextSectors = air ? ctx.dayLegs.filter((l) => l.stdMs > flight.stdMs) : ctx.nextSectors;
  const first = air ? flight : ctx.nextSectors[0]!;
  const tAnchor = air ? T.airborne!.flight : T.aircraft.nextSectors[0]!.flight;

  // ---- flights: align the template tail's legs on the flight's legs at the first affected sector
  const tLegs = [
    ...new Map(
      [
        ...T.world.rotation.filter((l) => l.tail === T.aircraft.tail),
        ...T.aircraft.nextSectors.map((s) => ({ ...s, tail: T.aircraft.tail, sta: s.std })),
        ...(T.airborne
          ? [
              {
                flight: T.airborne.flight,
                tail: T.aircraft.tail,
                from: T.airborne.from,
                to: T.airborne.plannedDestination,
                std: T.startSimTime,
                sta: T.startSimTime,
              },
            ]
          : []),
      ].map((l) => [l.flight, l]),
    ).values(),
  ].sort((a, b) => Date.parse(a.std) - Date.parse(b.std));
  const aT = Math.max(
    0,
    tLegs.findIndex((l) => l.flight === tAnchor),
  );
  const aC = ctx.dayLegs.findIndex((l) => l.flight === first.flight);
  const lastC = ctx.dayLegs.length - 1;
  const legPairs: [{ flight: string; from: string; to: string }, NetworkFlight][] = [];
  tLegs.forEach((l, i) => {
    const k = i - aT;
    const j = k >= 0 ? Math.min(aC + k, lastC) : aC + k >= 0 ? aC + k : aC > 0 ? aC - 1 : aC;
    legPairs.push([l, ctx.dayLegs[j]!]);
  });
  // ---- stations
  const stationMap: Record<string, string> = { [T.aircraft.station]: S };
  if (T.airborne && !(T.airborne.plannedDestination in stationMap))
    stationMap[T.airborne.plannedDestination] = flight.to;
  if (T.aircraft.station !== HOME && !(HOME in stationMap)) stationMap[HOME] = B;
  if (T.airborne && !(T.airborne.from in stationMap)) stationMap[T.airborne.from] = flight.from;
  // The template tail's route follows the flight's route (so a destination named in a message stays right).
  for (const [tl, cl] of legPairs)
    for (const [a, b] of [
      [tl.from, cl.from],
      [tl.to, cl.to],
    ] as const)
      if (!(a in stationMap)) stationMap[a] = b;
  const taken = new Set([S, B, ...Object.values(stationMap)]);
  const others = otherStations(T)
    .filter((c) => !(c in stationMap))
    .sort(
      (a, b) =>
        haversineKm(stationByIata(a)!, stationByIata(T.aircraft.station)!) -
        haversineKm(stationByIata(b)!, stationByIata(T.aircraft.station)!),
    );
  const sOrigin = stationByIata(S)!;
  const nearest = NETWORK_STATIONS.filter((s) => !taken.has(s.iata)).sort(
    (a, b) => haversineKm(a, sOrigin) - haversineKm(b, sOrigin),
  );
  others.forEach((code, i) => (stationMap[code] = nearest[i]?.iata ?? code));

  const tokens: Record<string, string> = {};
  const idCodes: Record<string, string> = {};
  for (const [from, to] of Object.entries(stationMap)) {
    const a = stationByIata(from);
    const b = stationByIata(to);
    tokens[from] = to;
    idCodes[from.toLowerCase()] = to.toLowerCase();
    if (a && b) {
      tokens[a.icao] = b.icao;
      tokens[a.city] = b.city;
      for (const alias of CITY_ALIASES[from] ?? []) tokens[alias] = b.city;
    }
  }

  for (const [tl, cl] of legPairs) tokens[tl.flight] = cl.flight;

  // ---- tails
  const tTails = [...new Set(JSON.stringify(T).match(/AX-[A-Z]{3}/g) ?? [])].filter(
    (x) => x !== T.aircraft.tail,
  );
  tokens[T.aircraft.tail] = ctx.tail.tail;
  freshTails(schedule, tTails.length, new Set([ctx.tail.tail])).forEach((nt, i) => (tokens[tTails[i]!] = nt));

  const tOther = [...new Set(JSON.stringify(T).match(/ACX\d{3}/g) ?? [])].filter((f) => !(f in tokens));
  freshFlights(schedule, tOther.length).forEach((nf, i) => (tokens[tOther[i]!] = nf));

  // ---- cohort and crew ids follow their flights
  const digits = (f: string) => f.slice(3);
  const cohortIds = new Set<string>();
  for (const c of T.world.cohorts) {
    const nf = tokens[c.flight] ?? c.flight;
    let id = c.id.replace(/^c\d{3}/, `c${digits(nf)}`);
    for (let n = 2; cohortIds.has(id); n++) id = `${id}-${n}`;
    cohortIds.add(id);
    tokens[c.id] = id;
  }
  const tDigits = digits(tAnchor);
  for (const cr of T.world.crew)
    if (cr.id.includes(`-${tDigits}-`))
      tokens[cr.id] = cr.id.replace(`-${tDigits}-`, `-${digits(first.flight)}-`);

  // ---- time: keep the template's lead time between sim start and the first affected departure
  const lead = air ? 0 : Date.parse(T.aircraft.nextSectors[0]!.std) - Date.parse(T.startSimTime);
  const startMs = air
    ? Math.floor(ctx.atMs / 60_000) * 60_000
    : Math.floor((first.stdMs - lead) / 60_000) * 60_000;
  const spec: RemapSpec = { tokens, idCodes, shiftMs: startMs - Date.parse(T.startSimTime) };
  const remapper = createRemapper(spec);
  const R = remapper.value(T);

  // ---- assemble
  const pax = new Map(ctx.dayLegs.map((l) => [l.flight, l.pax]));
  const tPax = new Map(T.aircraft.nextSectors.map((s) => [tokens[s.flight] ?? s.flight, s.pax]));
  const cohorts: Cohort[] = R.world.cohorts.map((c) => ({ ...c }));
  for (const f of new Set(cohorts.map((c) => c.flight))) {
    const group = cohorts.filter((c) => c.flight === f);
    const target = pax.get(f) ?? 0;
    const was = group.reduce((n, c) => n + c.count, 0);
    const isFirst = f === first.flight;
    const factor = isFirst ? target / Math.max(1, was) : target / Math.max(1, tPax.get(f) ?? was);
    for (const c of group) c.count = Math.max(1, Math.round(c.count * factor));
    if (isFirst) {
      const sum = group.reduce((n, c) => n + c.count, 0);
      const gen = group.find((c) => c.kind === 'general') ?? group[0]!;
      gen.count = Math.max(1, gen.count + (target - sum));
    } else for (const c of group) c.count = Math.min(c.count, Math.max(1, target));
  }

  const crewDuty = crewFor(schedule, first.flight);
  const crew = R.world.crew.map((c) =>
    c.status === 'operating' && crewDuty
      ? { ...c, reportTime: crewDuty.report, sectorsPlanned: crewDuty.sectors, maxFdpMin: crewDuty.maxFdpMin }
      : c,
  );

  const { distanceTableKm: _drop, ...world } = R.world;
  const { eu261TierEur: _tier, ...kpiParams } = R.kpiParams;
  const dest = stationByIata(first.to)!;
  const city = stationByIata(S)!.city;
  const inbound = ctx.arrived ? ctx.flight : ctx.dayLegs[aC - 1];
  const narrative =
    NARRATIVE[t0.id]?.({
      city,
      time: hhmm(startMs),
      flight: first.flight,
      dest: dest.city,
      type: ctx.tail.type,
      tail: ctx.tail.tail,
      pax: first.pax,
      std: hhmm(first.stdMs),
      inbound:
        inbound && inbound.to === S
          ? `${inbound.flight} from ${stationByIata(inbound.from)?.city ?? inbound.from}`
          : undefined,
      more: air
        ? nextSectors.length
          ? `${ctx.tail.tail} has ${nextSectors.length} more sector${nextSectors.length > 1 ? 's' : ''} planned today.`
          : `It is ${ctx.tail.tail}'s last flight today.`
        : nextSectors.length > 1
          ? `${ctx.tail.tail} has ${nextSectors.length - 1} more sector${nextSectors.length > 2 ? 's' : ''} planned today.`
          : `It is ${ctx.tail.tail}'s last flight today.`,
    }) ?? R.narrative;

  const scenario: Scenario = {
    schemaVersion: 1,
    id: `fc-${schedule.date}-${flightId.toLowerCase()}-${type.id.replace(/_/g, '-')}`.slice(0, 64),
    title: `${type.label}: ${first.flight} at ${S}`,
    narrative: `${narrative} Built from Accent Air's live network (fictional day schedule, ${schedule.date}).`,
    visibility: 'private',
    inspiredBy: t0.inspiredBy,
    startSimTime: iso(startMs),
    aircraft: {
      ...R.aircraft,
      tail: ctx.tail.tail,
      type: ctx.tail.type,
      station: S,
      nextSectors: nextSectors.map(sectorOf),
    },
    trigger: R.trigger,
    world: {
      ...world,
      spares: R.world.spares.map((s) => ({ ...s, type: ctx.tail.type })),
      crew,
      cohorts,
      rotation: [...ctx.dayLegs.map(legOf), ...R.world.rotation.filter((l) => l.tail !== ctx.tail.tail)],
    },
    twists: air ? airborneTwists(R.twists, flight, S, startMs) : R.twists,
    baseline: air ? keepFlights(dedupeStringArrays(R.baseline), nextSectors) : dedupeStringArrays(R.baseline),
    expected: R.expected,
    kpiParams,
    ...(air
      ? {
          airborne: {
            flight: flight.flight,
            from: flight.from,
            plannedDestination: flight.to,
            position: { lat: round3(airState!.position.lat), lon: round3(airState!.position.lon) },
            altitudeFt: airState!.altitudeFt,
            headingDeg: airState!.headingDeg ?? 0,
            etaMinute: Math.max(1, Math.round((airState!.times.landingMs - startMs) / 60_000)),
            fuelEnduranceMin: airState!.fuelEnduranceMin ?? 90,
            squawk: 'normal' as const,
            pax: flight.pax,
          },
        }
      : {}),
  };

  return {
    scenario,
    type,
    context: ctx,
    remap: remapper.value,
    preview: {
      trigger: scenario.trigger.description,
      facts: [
        air
          ? `${ctx.tail.tail} (${ctx.tail.type}) in the air as ${flight.flight} ${flight.from}→${flight.to} with ${flight.pax} passengers; in this scenario the commander lands at ${S}`
          : `${ctx.tail.tail} (${ctx.tail.type}) at ${S}, ${first.flight} to ${first.to} due ${hhmm(first.stdMs)}Z with ${first.pax} passengers`,
        `${nextSectors.length} later sector${nextSectors.length === 1 ? '' : 's'} affected today`,
        scenario.world.spares.length
          ? `Spare: ${scenario.world.spares.map((s) => `${s.tail} at ${s.station}`).join(', ')}`
          : 'No spare aircraft nearby',
        `Engineers: ${scenario.world.engineers.filter((e) => e.station === S).length} on station, ${scenario.world.engineers.filter((e) => e.station !== S).length} elsewhere`,
      ],
      twists: scenario.twists.map((t) => t.title),
    },
  };
}
