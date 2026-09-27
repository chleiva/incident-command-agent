/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * occ — operations control / rotation (spec §7).
 *
 * Rules:
 * - Swap (task 06): approving `propose_swap` SENDS A REQUEST to OCC (`SwapDecision.status = 'requested'`); OCC
 *   confirms it `OCC_CONFIRM_MIN` minutes later in `tick` by re-planning and executing it (`executed`), or refuses it
 *   (`rejected`, with `occNote`) when it is no longer feasible. `executeSwap` stays for direct execution (tests).
 * - Swap feasibility: needs a spare of a compatible type (same family, enough seats) at the same station as the first swapped
 *   flight, not already assigned and without a conflicting flight of its own. It is on time when the spare is
 *   available by STD − the 35-minute minimum turn; otherwise the swapped flights are re-timed to
 *   `availableFrom + 35` (never earlier than now + 35). A resulting departure/arrival inside a curfew is refused.
 * - Cancellation: the flight is cancelled; downstream flights of that tail that start away from where the aircraft
 *   now is are cancelled too, until the rotation returns to the aircraft's station.
 * - Reactionary delay: the next STD slips by the arrival delay minus the buffer (ground time − 35 min).
 * - Curfew: an ETD (at the origin) or ETA (at the destination) inside a curfew window is blocked; slipping ETDs
 *   are pushed to the end of the curfew.
 * - tick: while a tail is not dispatchable (mne status unserviceable/aog), its next flight's ETD slips to
 *   now + 20 min (5-minute steps) and the delay propagates; a dispatchable flight whose ETD has passed departs.
 */
import { localHhMm } from '@ica/kb';
import { seedAirborne, tickAirborne } from './airborne';
import type {
  Actor,
  AircraftType,
  CancelDecision,
  Curfew,
  Flight,
  MockSystem,
  Scenario,
  Spare,
  SwapDecision,
  SystemMutation,
  SystemState,
  SystemStateOf,
} from '@ica/schema';
import {
  MIN_TURN_MIN,
  applyMutations,
  ceilTo,
  changes,
  created,
  fail,
  isoAt,
  minuteOf,
  netMutations,
  newId,
  originMs,
  updated,
  type Result,
} from '../util';

/** Seats per type (typical single-class layouts; fictional carrier config). */
export const SEATS: Record<AircraftType, number> = {
  A319: 156,
  A320: 180,
  A321: 220,
  B737: 149,
  B738: 189,
  E190: 100,
};
const FAMILY: Record<AircraftType, string> = {
  A319: 'A320F',
  A320: 'A320F',
  A321: 'A320F',
  B737: 'B737NG',
  B738: 'B737NG',
  E190: 'E-JET',
};

/** Same type-rating family and enough seats for the passengers booked. */
export function compatibleType(spare: AircraftType, needed: AircraftType, pax: number): boolean {
  return FAMILY[spare] === FAMILY[needed] && SEATS[spare] >= pax;
}

const ACTIVE: Flight['status'][] = ['scheduled', 'delayed', 'boarding', 'swapped'];
export const isActive = (f: Flight) => ACTIVE.includes(f.status);

export { seedAirborne, tickAirborne, airborneNow } from './airborne';

export function seedOcc(scenario: Scenario): SystemStateOf<'occ'> {
  const origin = scenario.startSimTime;
  const flights: Record<string, Flight> = {};
  for (const leg of scenario.world.rotation) {
    flights[leg.flight] = {
      flight: leg.flight,
      tail: leg.tail,
      from: leg.from,
      to: leg.to,
      std: leg.std,
      sta: leg.sta,
      status: minuteOf(origin, leg.std) < 0 ? 'departed' : 'scheduled', // legs already flown before sim start
      delayMin: 0,
      reactionaryDelayMin: 0,
      pax: leg.pax,
      stdMinute: minuteOf(origin, leg.std),
      staMinute: minuteOf(origin, leg.sta),
    };
  }
  for (const s of scenario.aircraft.nextSectors) {
    if (flights[s.flight]) continue;
    const block = Math.round((s.distanceKm / 780) * 60 + 25);
    const sta = isoAt(origin, minuteOf(origin, s.std) + block);
    flights[s.flight] = {
      flight: s.flight,
      tail: scenario.aircraft.tail,
      from: s.from,
      to: s.to,
      std: s.std,
      sta,
      status: minuteOf(origin, s.std) < 0 ? 'departed' : 'scheduled',
      delayMin: 0,
      reactionaryDelayMin: 0,
      pax: s.pax,
      stdMinute: minuteOf(origin, s.std),
      staMinute: minuteOf(origin, sta),
    };
  }
  const spares: Record<string, Spare> = {};
  for (const s of scenario.world.spares)
    spares[s.tail] = {
      tail: s.tail,
      type: s.type,
      station: s.station,
      availableFromMinute: s.availableFromMinute,
    };
  const curfews: Record<string, Curfew> = {};
  for (const c of scenario.world.curfews) curfews[c.station] = { ...c };
  return {
    flights,
    spares,
    swaps: {},
    cancellations: {},
    curfews,
    airborne: seedAirborne(scenario),
    commanderLog: {},
  };
}

// ------------------------------------------------------------------ time helpers
function origin(state: SystemState): number {
  const o = originMs(state);
  if (o === undefined)
    throw new Error('occ: no flight carries stdMinute; cannot relate ISO times to sim minutes');
  return o;
}
const toMinute = (state: SystemState, iso: string) => (Date.parse(iso) - origin(state)) / 60_000;
const toIso = (state: SystemState, minute: number) =>
  new Date(origin(state) + Math.round(minute * 60_000)).toISOString().replace(/\.000Z$/, 'Z');

export const stdMin = (state: SystemState, f: Flight) => f.stdMinute ?? toMinute(state, f.std);
export const staMin = (state: SystemState, f: Flight) => f.staMinute ?? toMinute(state, f.sta);
export const blockMin = (state: SystemState, f: Flight) => staMin(state, f) - stdMin(state, f);
/** Current estimated departure minute. */
export const etdMin = (state: SystemState, f: Flight) =>
  f.etd ? toMinute(state, f.etd) : stdMin(state, f) + f.delayMin;
/** Current estimated arrival minute. */
export const etaMin = (state: SystemState, f: Flight) => etdMin(state, f) + blockMin(state, f);

/** Flights of a tail in STD order. */
export function tailFlights(state: SystemState, tail: string): Flight[] {
  return Object.values(state.occ.flights)
    .filter((f) => f.tail === tail)
    .sort((a, b) => stdMin(state, a) - stdMin(state, b));
}

// ------------------------------------------------------------------ curfews
function inWindow(hhmm: string, from: string, to: string): boolean {
  return from <= to ? hhmm >= from && hhmm < to : hhmm >= from || hhmm < to;
}

/** The curfew at `station` that `minute` falls into, if any. */
export function curfewAt(state: SystemState, station: string, minute: number): Curfew | undefined {
  const c = state.occ.curfews[station];
  if (!c) return undefined;
  const local = localHhMm(station, new Date(origin(state) + minute * 60_000));
  return inWindow(local, c.fromLocal, c.toLocal) ? c : undefined;
}

/** First minute ≥ `minute` outside the curfew at `station` (scans in 5-minute steps, max 24 h). */
export function curfewEnd(state: SystemState, station: string, minute: number): number {
  let m = minute;
  for (let i = 0; i < 24 * 12 && curfewAt(state, station, m); i++) m = ceilTo(m + 5, 5);
  return m;
}

/** Why a departure at `etd` for flight `f` would be blocked by a curfew (origin ETD or destination ETA). */
export function curfewConflict(state: SystemState, f: Flight, etd: number): string | undefined {
  if (curfewAt(state, f.from, etd)) {
    const c = state.occ.curfews[f.from];
    return `ETD ${toIso(state, etd)} is inside the ${f.from} curfew (${c.fromLocal}–${c.toLocal} local)`;
  }
  const eta = etd + blockMin(state, f);
  if (curfewAt(state, f.to, eta)) {
    const c = state.occ.curfews[f.to];
    return `ETA ${toIso(state, eta)} is inside the ${f.to} curfew (${c.fromLocal}–${c.toLocal} local)`;
  }
  return undefined;
}

// ------------------------------------------------------------------ delays
/**
 * Re-time `flightNo` to depart at `newEtd` (never earlier than STD) and propagate reactionary delay down the tail's
 * rotation: next ETD = max(its current ETD, previous ETA + 35). `reactionary` marks the first flight's delay as
 * reactionary too (used by the chain itself).
 */
export function retimeFlight(
  state: SystemState,
  flightNo: string,
  newEtd: number,
  patch: Partial<Flight> = {},
  reactionary = false,
): SystemMutation[] {
  const out: SystemMutation[] = [];
  let s = state;
  let f = s.occ.flights[flightNo];
  if (!f) return out;
  let etd = Math.max(newEtd, stdMin(s, f));
  let isReactionary = reactionary;
  for (;;) {
    const delay = Math.round(etd - stdMin(s, f));
    const p: Partial<Flight> = {
      etd: delay > 0 ? toIso(s, etd) : undefined,
      delayMin: delay,
      reactionaryDelayMin: isReactionary
        ? delay
        : f.reactionaryDelayMin > delay
          ? delay
          : f.reactionaryDelayMin,
      ...(f.status === 'scheduled' && delay > 0 ? { status: 'delayed' as const } : {}),
      ...patch,
    };
    if (changes(f, p)) {
      const m = updated('occ', 'flights', f.flight, f, p);
      out.push(m);
      s = applyMutations(s, [m]);
    }
    const arrival = etd + blockMin(s, f);
    const next = tailFlights(s, f.tail).find((x) => stdMin(s, x) > stdMin(s, f) && isActive(x));
    if (!next) break;
    const earliest = arrival + MIN_TURN_MIN;
    if (etdMin(s, next) >= earliest) break;
    f = next;
    etd = earliest;
    patch = {};
    isReactionary = true;
  }
  return out;
}

// ------------------------------------------------------------------ swaps
export interface SwapPlan {
  fromTail: string;
  toTail: string;
  flights: string[];
  onTime: boolean;
  departureMinute: number;
  delayMin: number;
}

export function planSwap(
  state: SystemState,
  input: { fromTail: string; toTail: string; flights: string[] },
  simMinute: number,
): Result<SwapPlan> {
  const spare = state.occ.spares[input.toTail];
  if (!spare) return fail(`${input.toTail} is not a spare aircraft`);
  if (spare.assignedTo) return fail(`spare ${input.toTail} is already assigned to ${spare.assignedTo}`);
  if (!input.flights.length) return fail('no flights to swap');
  const flights = input.flights.map((n) => state.occ.flights[n]);
  const missing = input.flights.filter((_, i) => !flights[i]);
  if (missing.length) return fail(`unknown flight(s) ${missing.join(', ')}`);
  for (const f of flights) {
    if (f.tail !== input.fromTail) return fail(`${f.flight} is operated by ${f.tail}, not ${input.fromTail}`);
    if (!isActive(f)) return fail(`${f.flight} is ${f.status}`);
  }
  flights.sort((a, b) => stdMin(state, a) - stdMin(state, b));
  const first = flights[0];
  const needed = state.mne.aircraft[input.fromTail]?.type;
  const maxPax = Math.max(...flights.map((f) => f.pax));
  if (needed && !compatibleType(spare.type, needed, maxPax))
    return fail(
      `spare ${spare.tail} (${spare.type}, ${SEATS[spare.type]} seats) is not compatible with ${needed} flights carrying up to ${maxPax} passengers`,
    );
  if (spare.station !== first.from)
    return fail(`spare ${spare.tail} is at ${spare.station}, but ${first.flight} departs from ${first.from}`);
  const spareAc = state.mne.aircraft[spare.tail];
  if (spareAc && (spareAc.status === 'unserviceable' || spareAc.status === 'aog'))
    return fail(`spare ${spare.tail} is ${spareAc.status}`);
  // The spare's own flights must not overlap the swapped block.
  const blockStart = stdMin(state, first);
  const blockEnd = staMin(state, flights[flights.length - 1]);
  const conflict = tailFlights(state, spare.tail).find(
    (f) =>
      isActive(f) &&
      stdMin(state, f) < blockEnd + MIN_TURN_MIN &&
      staMin(state, f) > blockStart - MIN_TURN_MIN,
  );
  if (conflict) return fail(`spare ${spare.tail} is already planned on ${conflict.flight}`);
  const current = etdMin(state, first);
  const departure = Math.max(current, spare.availableFromMinute + MIN_TURN_MIN, simMinute + MIN_TURN_MIN);
  const onTime =
    spare.availableFromMinute + MIN_TURN_MIN <= stdMin(state, first) && departure <= stdMin(state, first);
  const blocked = curfewConflict(state, first, departure);
  if (blocked) return fail(`swap blocked by curfew: ${blocked}`);
  return {
    ok: true,
    value: {
      fromTail: input.fromTail,
      toTail: input.toTail,
      flights: flights.map((f) => f.flight),
      onTime,
      departureMinute: departure,
      delayMin: Math.max(0, Math.round(departure - stdMin(state, first))),
    },
    mutations: [],
  };
}

/** Minutes OCC takes to confirm and execute a swap request (modelled process, `tick`). */
export const OCC_CONFIRM_MIN = 5;

/**
 * Send an approved swap request to OCC: checks feasibility now and records `SwapDecision{status:'requested'}`.
 * Nothing is re-tailed yet; OCC confirms and executes it in `tick` at `confirmAtMinute`.
 */
export function requestSwap(
  state: SystemState,
  input: { fromTail: string; toTail: string; flights: string[] },
  simMinute: number,
  approvedBy: Actor | undefined,
  rng: () => number,
): Result<SwapDecision & { plan: SwapPlan }> {
  const plan = planSwap(state, input, simMinute);
  if (!plan.ok) return plan;
  const p = plan.value;
  const id = newId('SWP', state.occ.swaps, rng);
  const confirmAtMinute = Math.round((simMinute + OCC_CONFIRM_MIN) * 100) / 100;
  const decision: SwapDecision = {
    id,
    fromTail: p.fromTail,
    toTail: p.toTail,
    flights: p.flights,
    status: 'requested',
    ...(approvedBy ? { approvedBy } : {}),
    requestedAtMinute: simMinute,
    confirmAtMinute,
  };
  return { ok: true, value: { ...decision, plan: p }, mutations: [created('occ', 'swaps', id, decision)] };
}

/** Re-tail and re-time the flights of a feasible swap plan and assign the spare (mutations only). */
function swapMutations(state: SystemState, p: SwapPlan): SystemMutation[] {
  const mutations: SystemMutation[] = [];
  let s = state;
  for (const n of p.flights) {
    const f = s.occ.flights[n];
    const m = updated('occ', 'flights', n, f, { tail: p.toTail, status: 'swapped' });
    mutations.push(m);
    s = applyMutations(s, [m]);
  }
  const retime = retimeFlight(s, p.flights[0], p.departureMinute);
  mutations.push(...retime);
  s = applyMutations(s, retime);
  const spare = s.occ.spares[p.toTail];
  mutations.push(updated('occ', 'spares', spare.tail, spare, { assignedTo: p.flights.join(',') }));
  return netMutations(mutations);
}

/** OCC's confirmation of due swap requests (modelled process): execute, or refuse when no longer feasible. */
export function confirmSwapRequests(state: SystemState, simMinute: number): SystemMutation[] {
  const out: SystemMutation[] = [];
  let s = state;
  for (const sw of Object.values(s.occ.swaps)) {
    if (sw.status !== 'requested' || (sw.confirmAtMinute ?? 0) > simMinute + 1e-9) continue;
    const plan = planSwap(s, { fromTail: sw.fromTail, toTail: sw.toTail, flights: sw.flights }, simMinute);
    const ms = plan.ok
      ? [
          ...swapMutations(s, plan.value),
          updated('occ', 'swaps', sw.id, sw, {
            status: 'executed',
            occNote: `Confirmed and executed by OCC at minute ${Math.round(simMinute)}`,
          }),
        ]
      : [
          updated('occ', 'swaps', sw.id, sw, {
            status: 'rejected',
            occNote: `OCC could not execute: ${plan.error}`,
          }),
        ];
    out.push(...ms);
    s = applyMutations(s, ms);
  }
  return out;
}

/** Execute an approved swap immediately: re-tail the flights, assign the spare, record the decision. */
export function executeSwap(
  state: SystemState,
  input: { fromTail: string; toTail: string; flights: string[] },
  simMinute: number,
  approvedBy: Actor | undefined,
  rng: () => number,
): Result<SwapDecision & { plan: SwapPlan }> {
  const plan = planSwap(state, input, simMinute);
  if (!plan.ok) return plan;
  const p = plan.value;
  const mutations = swapMutations(state, p);
  const s = applyMutations(state, mutations);
  const id = newId('SWP', s.occ.swaps, rng);
  const decision: SwapDecision = {
    id,
    fromTail: p.fromTail,
    toTail: p.toTail,
    flights: p.flights,
    status: 'executed',
    ...(approvedBy ? { approvedBy } : {}),
  };
  mutations.push(created('occ', 'swaps', id, decision));
  return { ok: true, value: { ...decision, plan: p }, mutations };
}

/** Flights that a cancellation of `flightNo` also cancels (the aircraft never reaches their origin). */
export function downstreamOfCancel(state: SystemState, flightNo: string): string[] {
  const f = state.occ.flights[flightNo];
  if (!f) return [];
  const position = f.from; // the aircraft stays where the cancelled flight would have left from
  const out: string[] = [];
  for (const next of tailFlights(state, f.tail)) {
    if (stdMin(state, next) <= stdMin(state, f) || !isActive(next)) continue;
    if (next.from === position) break; // the rotation resumes from where the aircraft is
    out.push(next.flight);
  }
  return out;
}

/** Execute an approved cancellation (plus the downstream legs it implies). */
export function executeCancel(
  state: SystemState,
  flightNo: string,
  approvedBy: Actor | undefined,
  rng: () => number,
): Result<{ decision: CancelDecision; alsoCancelled: string[] }> {
  const f = state.occ.flights[flightNo];
  if (!f) return fail(`unknown flight ${flightNo}`);
  if (!isActive(f)) return fail(`${flightNo} is ${f.status}`);
  const also = downstreamOfCancel(state, flightNo);
  const mutations: SystemMutation[] = [];
  for (const n of [flightNo, ...also]) {
    const x = state.occ.flights[n];
    mutations.push(updated('occ', 'flights', n, x, { status: 'cancelled' }));
  }
  const id = newId('CNL', state.occ.cancellations, rng);
  const decision: CancelDecision = {
    id,
    flight: flightNo,
    status: 'executed',
    ...(approvedBy ? { approvedBy } : {}),
  };
  mutations.push(created('occ', 'cancellations', id, decision));
  return { ok: true, value: { decision, alsoCancelled: also }, mutations };
}

/** Is the tail dispatchable (mne status)? Tails unknown to mne are assumed serviceable. */
export function dispatchable(state: SystemState, tail: string): boolean {
  const ac = state.mne.aircraft[tail];
  return !ac || ac.status === 'serviceable' || ac.status === 'released';
}

export function tickOcc(state: SystemState, simMinute: number, _dtMin: number): SystemMutation[] {
  if (originMs(state) === undefined) return [];
  const out: SystemMutation[] = [...confirmSwapRequests(state, simMinute), ...tickAirborne(state, simMinute)];
  let s = out.length ? applyMutations(state, out) : state;
  const tails = new Set(Object.values(s.occ.flights).map((f) => f.tail));
  for (const tail of tails) {
    const next = tailFlights(s, tail).find(isActive);
    if (!next) continue;
    const etd = etdMin(s, next);
    if (dispatchable(s, tail)) {
      if (simMinute >= etd) {
        const m = updated('occ', 'flights', next.flight, next, { status: 'departed' });
        out.push(m);
        s = applyMutations(s, [m]);
      }
      continue;
    }
    if (simMinute + 20 > etd) {
      let newEtd = ceilTo(simMinute + 20, 5);
      if (curfewConflict(s, next, newEtd)) newEtd = curfewEnd(s, next.from, newEtd);
      const ms = retimeFlight(s, next.flight, newEtd);
      out.push(...ms);
      s = applyMutations(s, ms);
    }
  }
  // A swap confirmed this tick can also depart or re-time the same flight: one net mutation per flight.
  return netMutations(out);
}

export const occ: MockSystem<'occ'> = {
  name: 'occ',
  seed: (scenario) => seedOcc(scenario),
  tick: tickOcc,
  knownRefs: (state) => ({
    flight: Object.keys(state.occ.flights),
    tail: [
      ...new Set([...Object.values(state.occ.flights).map((f) => f.tail), ...Object.keys(state.occ.spares)]),
    ],
    station: [
      ...new Set([
        ...Object.values(state.occ.flights).flatMap((f) => [f.from, f.to]),
        ...Object.values(state.occ.airborne ?? {}).flatMap((a) => [
          a.from,
          a.plannedDestination,
          a.destination,
        ]),
      ]),
    ],
  }),
};
