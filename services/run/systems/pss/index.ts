/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * pss — passenger service / DCS (spec §7).
 *
 * Rules:
 * - EU261 tier by great-circle distance: ≤ 1500 km €250; intra-EU > 1500 km, or 1500–3500 km, €400; otherwise
 *   €600. Compensation exposure applies when the projected arrival delay reaches 3 h (or the flight is cancelled).
 * - Rebooking only onto flights of the same route with enough `seatsAvailable`, which it decrements.
 * - Messages record `sentAtMinute` and set each cohort's `firstInformedAtMinute` (first time only).
 * - Rebooking options are generated at seed: fictional later ACX flights with seeded seat counts.
 */
import { distanceKm, isEuStation } from '@ica/kb';
import type {
  Actor,
  Cohort,
  MockSystem,
  PassengerMessage,
  RebookingOption,
  Scenario,
  SystemMutation,
  SystemState,
  SystemStateOf,
  Voucher,
} from '@ica/schema';
import { created, fail, isoAt, minuteOf, newId, randInt, updated, type Result } from '../util';

export type Eu261Tier = 250 | 400 | 600;

/** EU261 compensation tier (Art. 7) by distance; `intraEu` = both ends in the EU/EEA. */
export function eu261TierEur(distance: number, intraEu: boolean): Eu261Tier {
  if (distance <= 1500) return 250;
  if (intraEu || distance <= 3500) return 400;
  return 600;
}

/** Distance of a route: scenario sector data, then the scenario's override table, then haversine. */
export function routeDistanceKm(scenario: Scenario | undefined, from: string, to: string): number {
  const sector = scenario?.aircraft.nextSectors.find((s) => s.from === from && s.to === to);
  if (sector) return sector.distanceKm;
  const t = scenario?.world.distanceTableKm;
  const o = t?.[from]?.[to] ?? t?.[to]?.[from];
  if (o !== undefined) return o;
  return distanceKm(from, to);
}

export function seedPss(scenario: Scenario, rng: () => number): SystemStateOf<'pss'> {
  const cohorts: Record<string, Cohort> = {};
  for (const c of scenario.world.cohorts) {
    const cohort: Cohort = {
      id: c.id,
      kind: c.kind,
      count: c.count,
      flight: c.flight,
      status: 'uninformed',
      careIssued: 0,
    };
    if (c.onwardDeadline) cohort.onwardDeadline = c.onwardDeadline;
    if (c.notes) cohort.notes = c.notes;
    cohorts[c.id] = cohort;
  }
  // Fictional rebooking options: 2–3 later ACX departures on each affected route.
  const used = new Set<string>([
    ...scenario.world.rotation.map((r) => r.flight),
    ...scenario.aircraft.nextSectors.map((s) => s.flight),
  ]);
  const legs = new Map<string, { from: string; to: string; std: string }>();
  for (const s of scenario.aircraft.nextSectors) legs.set(s.flight, { from: s.from, to: s.to, std: s.std });
  for (const r of scenario.world.rotation) if (!legs.has(r.flight)) legs.set(r.flight, r);
  const routes = new Map<string, { from: string; to: string; std: string }>();
  for (const c of scenario.world.cohorts) {
    const leg = legs.get(c.flight);
    if (leg && !routes.has(`${leg.from}-${leg.to}`)) routes.set(`${leg.from}-${leg.to}`, leg);
  }
  const rebookingOptions: Record<string, RebookingOption> = {};
  let n = 800 + randInt(rng, 0, 40);
  for (const leg of routes.values()) {
    const count = randInt(rng, 2, 3);
    let offset = randInt(rng, 120, 200);
    for (let i = 0; i < count; i++) {
      while (used.has(`ACX${n}`)) n++;
      const flight = `ACX${n}`;
      used.add(flight);
      n += randInt(rng, 1, 7);
      const std = isoAt(scenario.startSimTime, minuteOf(scenario.startSimTime, leg.std) + offset);
      rebookingOptions[flight] = {
        flight,
        from: leg.from,
        to: leg.to,
        std,
        seatsAvailable: randInt(rng, 4, 48),
      };
      offset += randInt(rng, 150, 360);
    }
  }
  return { cohorts, rebookingOptions, vouchers: {}, messages: {} };
}

export interface ExposureLine {
  cohortId: string;
  flight: string;
  count: number;
  tierEur: Eu261Tier;
  distanceKm: number;
  projectedArrivalDelayMin: number;
  compensationEligible: boolean;
  exposureEur: number;
}

/**
 * EU261 exposure per cohort: count × tier when the projected arrival delay ≥ 180 min or the flight is cancelled
 * (and the cohort was not rebooked to arrive in time). `extraDelayMin` lets callers test "what if".
 */
export function estimateExposure(
  state: SystemState,
  scenario: Scenario | undefined,
  cohortIds: string[] | undefined,
  extraDelayMin = 0,
): Result<{ lines: ExposureLine[]; totalEur: number; minutesTo3h: number | null }> {
  const ids = cohortIds?.length ? cohortIds : Object.keys(state.pss.cohorts);
  const lines: ExposureLine[] = [];
  let minutesTo3h: number | null = null;
  for (const id of ids) {
    const c = state.pss.cohorts[id];
    if (!c) return fail(`unknown cohort ${id}`);
    const f = state.occ.flights[c.flight];
    if (!f) return fail(`cohort ${id} is on unknown flight ${c.flight}`);
    const d = routeDistanceKm(scenario, f.from, f.to);
    const tier =
      scenario?.kpiParams.eu261TierEur ?? eu261TierEur(d, isEuStation(f.from) && isEuStation(f.to));
    const delay = f.delayMin + extraDelayMin;
    const eligible = (f.status === 'cancelled' || delay >= 180) && c.status !== 'rebooked';
    if (f.status !== 'cancelled' && delay < 180) minutesTo3h = Math.min(minutesTo3h ?? Infinity, 180 - delay);
    lines.push({
      cohortId: id,
      flight: c.flight,
      count: c.count,
      tierEur: tier,
      distanceKm: d,
      projectedArrivalDelayMin: delay,
      compensationEligible: eligible,
      exposureEur: eligible ? c.count * tier : 0,
    });
  }
  return {
    ok: true,
    value: { lines, totalEur: lines.reduce((a, l) => a + l.exposureEur, 0), minutesTo3h },
    mutations: [],
  };
}

/** Rebook a whole cohort onto a flight with enough seats on the same route. */
export function rebookCohort(state: SystemState, cohortId: string, toFlight: string): Result<Cohort> {
  const c = state.pss.cohorts[cohortId];
  if (!c) return fail(`unknown cohort ${cohortId}`);
  if (c.status === 'rebooked') return fail(`cohort ${cohortId} is already rebooked to ${c.rebookedTo}`);
  const opt = state.pss.rebookingOptions[toFlight];
  if (!opt) return fail(`${toFlight} is not a rebooking option`);
  const orig = state.occ.flights[c.flight];
  if (orig && (opt.from !== orig.from || opt.to !== orig.to))
    return fail(
      `${toFlight} flies ${opt.from}–${opt.to}, but cohort ${cohortId} travels ${orig.from}–${orig.to}`,
    );
  if (opt.seatsAvailable < c.count)
    return fail(`${toFlight} has ${opt.seatsAvailable} seats; cohort ${cohortId} needs ${c.count}`);
  const mutations: SystemMutation[] = [
    updated('pss', 'rebookingOptions', toFlight, opt, { seatsAvailable: opt.seatsAvailable - c.count }),
  ];
  const m = updated('pss', 'cohorts', cohortId, c, { status: 'rebooked', rebookedTo: toFlight });
  mutations.push(m);
  return { ok: true, value: m.after as Cohort, mutations };
}

/** Store a draft passenger message (always AI-drafted). */
export function draftMessage(
  state: SystemState,
  input: { cohortIds: string[]; channel: PassengerMessage['channel']; body: string },
  rng: () => number,
): Result<PassengerMessage> {
  for (const id of input.cohortIds) if (!state.pss.cohorts[id]) return fail(`unknown cohort ${id}`);
  const id = newId('MSG', state.pss.messages, rng);
  const msg: PassengerMessage = {
    id,
    cohortIds: [...input.cohortIds],
    channel: input.channel,
    body: input.body,
    status: 'draft',
    aiDrafted: true,
  };
  return { ok: true, value: msg, mutations: [created('pss', 'messages', id, msg)] };
}

/** Send a message (an existing draft, or a new body): status sent, cohorts informed the first time. */
export function sendMessage(
  state: SystemState,
  input: { messageId?: string; cohortIds?: string[]; channel?: PassengerMessage['channel']; body?: string },
  simMinute: number,
  approvedBy: Actor | undefined,
  rng: () => number,
): Result<PassengerMessage> {
  const mutations: SystemMutation[] = [];
  let msg: PassengerMessage;
  if (input.messageId) {
    const existing = state.pss.messages[input.messageId];
    if (!existing) return fail(`unknown message ${input.messageId}`);
    if (existing.status === 'sent') return fail(`message ${input.messageId} was already sent`);
    if (existing.status === 'blocked')
      return fail(`message ${input.messageId} was blocked by output screening`);
    const m = updated('pss', 'messages', existing.id, existing, {
      status: 'sent',
      sentAtMinute: simMinute,
      ...(approvedBy ? { approvedBy } : {}),
    });
    mutations.push(m);
    msg = m.after as PassengerMessage;
  } else {
    if (!input.cohortIds?.length || !input.body) return fail('give either messageId, or cohortIds and body');
    for (const id of input.cohortIds) if (!state.pss.cohorts[id]) return fail(`unknown cohort ${id}`);
    const id = newId('MSG', state.pss.messages, rng);
    msg = {
      id,
      cohortIds: [...input.cohortIds],
      channel: input.channel ?? 'sms',
      body: input.body,
      status: 'sent',
      aiDrafted: true,
      sentAtMinute: simMinute,
      ...(approvedBy ? { approvedBy } : {}),
    };
    mutations.push(created('pss', 'messages', id, msg));
  }
  for (const cid of msg.cohortIds) {
    const c = state.pss.cohorts[cid];
    if (!c) continue;
    const patch: Partial<Cohort> = {};
    if (c.firstInformedAtMinute === undefined) patch.firstInformedAtMinute = simMinute;
    if (c.status === 'uninformed') patch.status = 'informed';
    if (Object.keys(patch).length) mutations.push(updated('pss', 'cohorts', cid, c, patch));
  }
  return { ok: true, value: msg, mutations };
}

/** Issue care vouchers (one per cohort, value = passengers × per-passenger amount). */
export function issueVouchers(
  state: SystemState,
  input: { cohortIds: string[]; kind: Voucher['kind']; valuePerPaxEur: number },
  simMinute: number,
  rng: () => number,
): Result<Voucher[]> {
  const mutations: SystemMutation[] = [];
  const vouchers: Voucher[] = [];
  let existing: Record<string, unknown> = { ...state.pss.vouchers };
  for (const cid of input.cohortIds) {
    const c = state.pss.cohorts[cid];
    if (!c) return fail(`unknown cohort ${cid}`);
    const id = newId('VCH', existing, rng);
    const v: Voucher = {
      id,
      cohortId: cid,
      kind: input.kind,
      valueEur: c.count * input.valuePerPaxEur,
      issuedAtMinute: simMinute,
    };
    existing = { ...existing, [id]: v };
    vouchers.push(v);
    mutations.push(created('pss', 'vouchers', id, v));
    mutations.push(
      updated('pss', 'cohorts', cid, c, {
        careIssued: c.careIssued + c.count,
        ...(c.status === 'rebooked' ? {} : { status: 'care_issued' as const }),
      }),
    );
  }
  return { ok: true, value: vouchers, mutations };
}

export const pss: MockSystem<'pss'> = {
  name: 'pss',
  seed: (scenario, rng) => seedPss(scenario, rng),
  tick: () => [],
  knownRefs: (state) => ({
    cohort: Object.keys(state.pss.cohorts),
    flight: Object.keys(state.pss.rebookingOptions),
  }),
};
