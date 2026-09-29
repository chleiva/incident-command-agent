/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Merge a Scenario Author patch that needs the day's network (authoritative free text):
 * - `commanderDecision`: the commander's decision for the incident flight, relayed to the ground, as a scenario twist
 *   (commander log + airborne destination/ETA). It stays a human decision: no tool can make it.
 * - `network`: flights of the day's network brought into the scenario (rotation legs, airborne entries, passenger
 *   cohorts), what the event does to them (delays, holds, cancellations, the commanders' diversions) as scenario
 *   twists, and extra spares. Every route, tail, time and position comes from the network slice, never from the
 *   model's output.
 * Pure and browser-safe (the mock back end uses it too). `networkPatchErrors` lists what the Run Lambda rejects.
 */
import {
  applyScenarioPatch,
  type Scenario,
  type ScenarioAuthoringSummary,
  type ScenarioPatch,
  type ScenarioTwist,
  type TwistEffect,
} from '@ica/schema/browser';
import { bearingDeg, haversineKm, interpolateGreatCircle } from '../geo';
import { stationByIata } from '../stations';
import type { NetworkSlice, NetworkSliceFlight } from './slice';

type Cohort = Scenario['world']['cohorts'][number];

export const COMMANDER_TWIST_ID = 'tw-commander-decision';
export const NETWORK_TWIST_PREFIX = 'net-';
/** Notional cruise speed for ETAs after a decision (km per minute ≈ 780 km/h). */
const KM_PER_MIN = 13;
const round3 = (n: number) => Math.round(n * 1000) / 1000;
const KIND_ID: Record<string, string> = { unaccompanied_minors: 'um' };

/** Where an aircraft flying from `pos` towards `to` is `minutes` later (great circle, notional speed). */
function advance(pos: { lat: number; lon: number }, to: string, minutes: number) {
  const dest = stationByIata(to);
  if (!dest || minutes <= 0) return pos;
  const d = haversineKm(pos, dest);
  return d <= 0 ? pos : interpolateGreatCircle(pos, dest, Math.min(1, (minutes * KM_PER_MIN) / d));
}

function decisionEffects(
  flight: string,
  id: string,
  at: number,
  pos: { lat: number; lon: number },
  decision: 'continue' | 'turnback' | 'divert',
  airport: string,
  currentEta: number,
  note: string,
  extra: { squawk?: string; overweightLanding?: boolean } = {},
): TwistEffect[] {
  const dest = stationByIata(airport);
  const eta =
    decision === 'continue' || !dest
      ? currentEta
      : at + Math.max(8, Math.round(haversineKm(pos, dest) / KM_PER_MIN + 10));
  return [
    {
      op: 'create',
      system: 'occ',
      entity: 'commanderLog',
      record: {
        id,
        atMinute: at,
        flight,
        decision,
        airport,
        overweightLanding: extra.overweightLanding ?? false,
        note,
        decidedBy: 'Commander',
      },
    },
    {
      op: 'patch',
      system: 'occ',
      entity: 'airborne',
      id: flight,
      patch: {
        destination: airport,
        etaMinute: eta,
        commanderDecision: decision,
        decisionAtMinute: at,
        lat: round3(pos.lat),
        lon: round3(pos.lon),
        positionAtMinute: at,
        headingDeg: dest ? Math.round(bearingDeg(pos, dest)) : 0,
        overweightLanding: extra.overweightLanding ?? false,
        ...(extra.squawk ? { squawk: extra.squawk } : {}),
      },
    },
    { op: 'info', text: `Commander (relayed to the ground), ${flight}: ${note}` },
  ];
}

function decisionTitle(decision: string, airport: string): string {
  return decision === 'divert'
    ? `diverting to ${airport}`
    : decision === 'turnback'
      ? `returning to ${airport}`
      : 'continuing';
}

/** Errors in the network-aware parts of a patch (empty = fine). JSON-pointer style, for the Author's retry. */
export function networkPatchErrors(
  base: Scenario,
  patch: ScenarioPatch,
  slice: NetworkSlice | undefined,
): string[] {
  const errors: string[] = [];
  const cd = patch.commanderDecision;
  const known = new Set(slice?.stations ?? []);
  if (cd) {
    if (!base.airborne)
      errors.push(
        '/commanderDecision the incident aircraft is not in the air: no commander decision to relay',
      );
    if (cd.decision === 'divert' && !cd.airport)
      errors.push('/commanderDecision/airport is required for divert');
    if (cd.airport && !stationByIata(cd.airport))
      errors.push(`/commanderDecision/airport ${cd.airport} is not a network station`);
  }
  const net = patch.network;
  if (!net) return errors;
  if (!slice) return [...errors, '/network no network slice is available for this report'];
  const byFlight = new Map(slice.flights.map((f) => [f.flight, f]));
  const seen = new Set<string>();
  for (const [i, nf] of net.flights.entries()) {
    const at = `/network/flights/${i}`;
    const f = byFlight.get(nf.flight);
    if (!f) {
      errors.push(`${at}/flight ${nf.flight} is not in the day's network slice`);
      continue;
    }
    if (seen.has(nf.flight)) errors.push(`${at}/flight ${nf.flight} is listed twice`);
    seen.add(nf.flight);
    const air = !!f.position;
    if (nf.effect === 'divert') {
      if (!air)
        errors.push(`${at}/effect divert: ${nf.flight} is not in the air (use delay, hold or cancel)`);
      if (!nf.divertTo) errors.push(`${at}/divertTo is required for divert`);
      else if (!known.has(nf.divertTo)) errors.push(`${at}/divertTo ${nf.divertTo} is not a network station`);
    } else if (nf.effect !== 'monitor' && air) {
      errors.push(`${at}/effect ${nf.effect}: ${nf.flight} is in the air (use divert or monitor)`);
    }
    if ((nf.effect === 'delay' || nf.effect === 'hold') && !nf.minutes)
      errors.push(`${at}/minutes is required for ${nf.effect}`);
    const total = (nf.cohorts ?? []).reduce((n, c) => n + c.count, 0);
    if (total > f.pax) errors.push(`${at}/cohorts total ${total} exceeds the ${f.pax} passengers booked`);
    if (base.airborne?.flight === nf.flight && nf.effect === 'divert')
      errors.push(`${at} use commanderDecision for the incident flight's own diversion`);
  }
  const tails = new Set(slice.flights.map((f) => f.tail));
  for (const [i, sp] of (net.spares ?? []).entries()) {
    const at = `/network/spares/${i}`;
    if (!tails.has(sp.tail)) errors.push(`${at}/tail ${sp.tail} is not in the day's network slice`);
    if (sp.tail === base.aircraft.tail) errors.push(`${at}/tail ${sp.tail} is the incident aircraft`);
    if (!known.has(sp.station)) errors.push(`${at}/station ${sp.station} is not a network station`);
  }
  return errors;
}

function effectLabel(nf: NonNullable<ScenarioPatch['network']>['flights'][number]): string {
  switch (nf.effect) {
    case 'delay':
      return `delayed ${nf.minutes} min`;
    case 'hold':
      return `held on the ground ${nf.minutes} min`;
    case 'cancel':
      return 'cannot operate (cancelled by the event)';
    case 'divert':
      return `commander diverting to ${nf.divertTo}`;
    default:
      return 'affected; monitor';
  }
}

/**
 * `applyScenarioPatch` plus the network-aware parts. Call `networkPatchErrors` first: invalid entries are skipped here,
 * never guessed.
 */
export function applyAuthoredPatch(base: Scenario, patch: ScenarioPatch, slice?: NetworkSlice): Scenario {
  const s = applyScenarioPatch(base, patch);

  // ---- the commander's decision for the incident flight (replaces the template's)
  const cd = patch.commanderDecision;
  if (cd && s.airborne) {
    const a = s.airborne;
    const airport =
      cd.decision === 'turnback' ? a.from : cd.decision === 'divert' ? cd.airport! : a.plannedDestination;
    const pos = advance(a.position, a.plannedDestination, cd.atMinute);
    s.twists = s.twists.filter((t) => t.id !== COMMANDER_TWIST_ID);
    s.twists.unshift({
      id: COMMANDER_TWIST_ID,
      title: `Commander: ${decisionTitle(cd.decision, airport)}`,
      atMinute: cd.atMinute,
      description:
        "The commander's decision, relayed to the ground. A human decision; agents only prepare the ground.",
      effects: decisionEffects(
        a.flight,
        'CMD-1',
        cd.atMinute,
        pos,
        cd.decision,
        airport,
        a.etaMinute,
        cd.note,
        {
          ...(cd.squawk ? { squawk: cd.squawk } : {}),
          ...(cd.overweightLanding !== undefined ? { overweightLanding: cd.overweightLanding } : {}),
        },
      ),
    });
  }

  // ---- network-wide event
  const net = patch.network;
  if (!net || !slice) return s;
  const byFlight = new Map(slice.flights.map((f) => [f.flight, f]));
  const offsetMin = Math.round((Date.parse(slice.at) - Date.parse(s.startSimTime)) / 60_000);
  const inRotation = new Set(s.world.rotation.map((l) => l.flight));
  const cohortIds = new Set(s.world.cohorts.map((c) => c.id));
  const cohortFlights = new Set(s.world.cohorts.map((c) => c.flight));
  const airborne = [...(s.world.airborneFlights ?? [])];
  const groups = new Map<number, { effects: TwistEffect[]; lines: string[] }>();
  let cmd = 1;

  for (const nf of net.flights) {
    const f: NetworkSliceFlight | undefined = byFlight.get(nf.flight);
    if (!f) continue;
    const own = s.airborne?.flight === f.flight;
    if (!inRotation.has(f.flight) && !own) {
      s.world.rotation.push({
        flight: f.flight,
        tail: f.tail,
        from: f.from,
        to: f.to,
        std: f.std,
        sta: f.sta,
        pax: f.pax,
      });
      inRotation.add(f.flight);
    }
    const eta = Math.max(1, Math.round((f.minutesToLanding ?? 0) + offsetMin));
    if (f.position && !own && !airborne.some((x) => x.flight === f.flight)) {
      airborne.push({
        flight: f.flight,
        tail: f.tail,
        from: f.from,
        plannedDestination: f.to,
        position: f.position,
        altitudeFt: f.altitudeFt ?? 0,
        headingDeg: f.headingDeg ?? 0,
        etaMinute: eta,
        fuelEnduranceMin: f.fuelEnduranceMin ?? 90,
        squawk: 'normal',
        pax: f.pax,
      });
    }
    if (!cohortFlights.has(f.flight) && f.pax > 0) {
      const digits = f.flight.slice(3);
      const groupsIn = nf.cohorts?.length ? nf.cohorts : [{ kind: 'general' as const, count: f.pax }];
      for (const c of groupsIn) {
        let id = `c${digits}-${KIND_ID[c.kind] ?? c.kind}`;
        for (let n = 2; cohortIds.has(id); n++) id = `c${digits}-${KIND_ID[c.kind] ?? c.kind}-${n}`;
        cohortIds.add(id);
        const cohort: Cohort = {
          id,
          kind: c.kind,
          count: Math.max(1, Math.min(c.count, f.pax)),
          flight: f.flight,
          ...('notes' in c && c.notes ? { notes: c.notes } : {}),
        };
        s.world.cohorts.push(cohort);
      }
      cohortFlights.add(f.flight);
    }

    const m = nf.atMinute ?? 0;
    const g = groups.get(m) ?? { effects: [], lines: [] };
    groups.set(m, g);
    g.lines.push(
      `${f.flight} ${f.from}-${f.to} (${f.pax} pax): ${effectLabel(nf)}${nf.note ? `. ${nf.note}` : ''}`,
    );
    if (nf.effect === 'delay' || nf.effect === 'hold') {
      g.effects.push({ op: 'delay', flight: f.flight, minutes: nf.minutes ?? 60 });
    } else if (nf.effect === 'cancel') {
      g.effects.push({
        op: 'patch',
        system: 'occ',
        entity: 'flights',
        id: f.flight,
        patch: { status: 'cancelled' },
      });
    } else if (nf.effect === 'divert' && f.position && nf.divertTo) {
      const pos = advance(f.position, f.to, m);
      g.effects.push(
        ...decisionEffects(
          f.flight,
          `CMD-N${++cmd}`,
          m,
          pos,
          'divert',
          nf.divertTo,
          eta,
          nf.note ?? `Diverting to ${nf.divertTo}.`,
        ).slice(0, 2),
      );
    }
  }
  s.world.airborneFlights = airborne;

  for (const sp of net.spares ?? []) {
    const f = slice.flights.find((x) => x.tail === sp.tail);
    if (!f || s.world.spares.some((x) => x.tail === sp.tail) || sp.tail === s.aircraft.tail) continue;
    s.world.spares.push({
      tail: sp.tail,
      type: f.type as Scenario['aircraft']['type'],
      station: sp.station,
      availableFromMinute: sp.availableFromMinute,
    });
  }

  const twists: ScenarioTwist[] = [...groups.entries()]
    .sort(([a], [b]) => a - b)
    .map(([m, g]) => ({
      id: `${NETWORK_TWIST_PREFIX}m${m}`,
      title:
        m === 0
          ? `Network: ${g.lines.length} flight${g.lines.length === 1 ? '' : 's'} affected`
          : `Network update: ${g.lines.length} more flight${g.lines.length === 1 ? '' : 's'} affected`,
      atMinute: m,
      description: g.lines.join('; ').slice(0, 1500),
      effects: [...g.effects, { op: 'info', text: `Network status: ${g.lines.join('; ')}`.slice(0, 2000) }],
    }));
  s.twists = [...s.twists.filter((t) => !t.id.startsWith(NETWORK_TWIST_PREFIX)), ...twists];
  return s;
}

/**
 * Distinct flights a scenario affects: legs not yet landed at sim minute 0 (the incident aircraft's rotation and any
 * network flights), its remaining sectors, and the flights in the air.
 */
export function scenarioFlightCount(s: Scenario): number {
  const start = Date.parse(s.startSimTime);
  return new Set([
    ...s.world.rotation.filter((l) => Date.parse(l.sta) >= start).map((l) => l.flight),
    ...s.aircraft.nextSectors.map((x) => x.flight),
    ...(s.airborne ? [s.airborne.flight] : []),
    ...(s.world.airborneFlights ?? []).map((a) => a.flight),
  ]).size;
}

/** The authored scenario at a glance, for the cockpit's "Scenario from your description" card (clipped). */
export function authoringSummaryOf(s: Scenario): ScenarioAuthoringSummary {
  const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t);
  return {
    title: clip(s.title, 120),
    triggerType: s.trigger.type,
    trigger: clip(s.trigger.description, 300),
    narrative: clip(s.narrative, 400),
    affectedFlights: scenarioFlightCount(s),
    ...(s.trigger.scope === 'network' ? { network: true } : {}),
  };
}
