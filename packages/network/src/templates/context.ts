/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** A selected flight's incident context (where the aircraft is, what it still has to fly) and the applicable types. */
import { rotationOf, type DaySchedule, type NetworkFlight, type NetworkTail } from '../schedule';
import { flightStateAt, flightTimes, isAirborne, type FlightPhase } from '../state';
import { suitableAirports } from '../suitability';
import { isBase } from '../stations';
import { INCIDENT_TYPES, type IncidentType } from './incidentTypes';

/**
 * Where an airborne incident ends (the scenario's world, standing in for the commander's decision): back to the
 * departure airport for a turnback or an early engine shutdown, otherwise the best-ranked suitable airport other
 * than the destination. Null when there is none within reach.
 */
export function arrivalFor(type: IncidentType, ctx: FlightIncidentContext): string | null {
  if (type.id === 'air_turnback' || type.id === 'engine_shutdown_overweight_landing') return ctx.flight.from;
  const st = flightStateAt(ctx.flight, ctx.atMs);
  const options = suitableAirports(st.position, ctx.flight.type, {
    atMs: ctx.atMs,
    exclude: [ctx.flight.to],
    maxDistanceKm: 700,
    limit: 3,
  });
  return options.find((o) => o.suitable)?.iata ?? null;
}

/**
 * Where the incident is placed relative to the SELECTED flight (demo review 2). By default it happens on the selected
 * flight, where it is now: before departure or taxiing → at its departure station; in the air → in the air on it.
 * - `on_flight`: exactly that (no note).
 * - `turnaround`: the selected flight has landed and the aircraft is still there: the incident happens at the gate
 *   at the arrival station and affects the aircraft's next departure (said explicitly).
 * - `moved_on`: the selected flight landed long ago and the aircraft has flown on: the incident is placed where the
 *   aircraft is now, on its current flight (said explicitly).
 * - `not_there_yet`: the selected flight has not started and the aircraft is still on an earlier flight: the incident
 *   is set at the departure station once the aircraft is there (said explicitly).
 */
export interface IncidentPlacement {
  kind: 'on_flight' | 'turnaround' | 'moved_on' | 'not_there_yet';
  /** One plain sentence for the report dialog; absent for `on_flight`. */
  note?: string;
}

export interface FlightIncidentContext {
  schedule: DaySchedule;
  /** The flight the incident is anchored on: the selected flight, or the aircraft's current flight (`moved_on`). */
  flight: NetworkFlight;
  /** The flight the duty manager selected. */
  selected: NetworkFlight;
  placement: IncidentPlacement;
  phase: FlightPhase;
  atMs: number;
  tail: NetworkTail;
  /** Where the incident happens: the departure station before take-off, the arrival station after landing. */
  station: string;
  /** True when the selected flight has landed (the incident affects the aircraft's next sectors). */
  arrived: boolean;
  /** The aircraft's remaining sectors from the incident station (not cancelled), in order. */
  nextSectors: NetworkFlight[];
  /** The tail's flown or planned legs today (not cancelled). */
  dayLegs: NetworkFlight[];
}

const PRE_DEPARTURE: readonly FlightPhase[] = ['scheduled', 'boarding'];
const ARRIVED: readonly FlightPhase[] = ['landed', 'at_gate'];
const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16);

/** "at the gate at MAN", "in the air to PMI"… (plain words for a placement note). */
function whereNow(f: NetworkFlight, atMs: number): string {
  switch (flightStateAt(f, atMs).phase) {
    case 'scheduled':
      return `at ${f.from}, before ${f.flight}`;
    case 'boarding':
      return `boarding ${f.flight} at ${f.from}`;
    case 'taxi_out':
      return `taxiing out at ${f.from} as ${f.flight}`;
    case 'airborne':
    case 'approach':
      return `in the air as ${f.flight} to ${f.to}`;
    case 'landed':
      return `just landed at ${f.to} as ${f.flight}`;
    case 'at_gate':
      return `at the gate at ${f.to} after ${f.flight}`;
    default:
      return `at ${f.from}`;
  }
}

function baseContext(
  schedule: DaySchedule,
  flight: NetworkFlight,
  atMs: number,
): Omit<FlightIncidentContext, 'selected' | 'placement'> {
  const tail = schedule.tails.find((t) => t.tail === flight.tail)!;
  const phase = flightStateAt(flight, atMs).phase;
  const arrived = ARRIVED.includes(phase);
  const dayLegs = rotationOf(schedule, flight.tail).filter((f) => !f.cancelled);
  const station = arrived ? flight.to : flight.from;
  const nextSectors = arrived
    ? dayLegs.filter((f) => f.stdMs >= flight.staMs)
    : flight.cancelled
      ? []
      : dayLegs.filter((f) => f.stdMs >= flight.stdMs);
  return { schedule, flight, phase, atMs, tail, station, arrived, nextSectors, dayLegs };
}

export function incidentContext(
  schedule: DaySchedule,
  flightId: string,
  atMs: number,
): FlightIncidentContext | undefined {
  const selected = schedule.flights.find((f) => f.flight === flightId);
  if (!selected) return undefined;
  const base = baseContext(schedule, selected, atMs);
  const tailName = base.tail.tail;

  if (base.arrived && !selected.cancelled) {
    // Has the aircraft flown on since? Its latest leg that is past boarding (taxiing, airborne or arrived).
    const current = base.dayLegs
      .filter((l) => l.stdMs >= selected.staMs && !PRE_DEPARTURE.includes(flightStateAt(l, atMs).phase))
      .at(-1);
    if (current) {
      const here = baseContext(schedule, current, atMs);
      const next = here.arrived ? here.nextSectors[0] : undefined;
      const tail = here.arrived
        ? next
          ? ` It applies at the next turnaround: ${next.flight} at ${here.station} (due ${hhmm(next.stdMs)}Z).`
          : ` ${tailName} has no further flights today.`
        : '';
      return {
        ...here,
        selected,
        placement: {
          kind: 'moved_on',
          note: `${selected.flight} landed at ${selected.to} at ${hhmm(flightTimes(selected).inBlockMs)}Z and ${tailName} has flown on: it is now ${whereNow(current, atMs)}, so the incident is placed there.${tail}`,
        },
      };
    }
    const next = base.nextSectors[0];
    return {
      ...base,
      selected,
      placement: {
        kind: 'turnaround',
        note: next
          ? `${selected.flight} has landed at ${selected.to}: this incident type applies at the next turnaround: ${next.flight} at ${selected.to} (due ${hhmm(next.stdMs)}Z).`
          : `${selected.flight} has landed at ${selected.to} and ${tailName} has no further flights today.`,
      },
    };
  }

  if (PRE_DEPARTURE.includes(base.phase) && !selected.cancelled) {
    // Is the aircraft at the departure station yet? The leg before this one must have landed.
    const prev = base.dayLegs.filter((l) => l.stdMs < selected.stdMs).at(-1);
    if (prev && !ARRIVED.includes(flightStateAt(prev, atMs).phase))
      return {
        ...base,
        selected,
        placement: {
          kind: 'not_there_yet',
          note: `${tailName} is not at ${selected.from} yet (it is ${whereNow(prev, atMs)}): the incident is set at ${selected.from} once it has arrived, before ${selected.flight} departs at ${hhmm(selected.stdMs)}Z.`,
        },
      };
  }

  return { ...base, selected, placement: { kind: 'on_flight' } };
}

export interface IncidentTypeOption {
  type: IncidentType;
  /** Can be started now. */
  enabled: boolean;
  /** Why not (plain language), when disabled. */
  reason?: string;
}

/** The incident types for the flight's phase, startable ones first. */
export function incidentTypesFor(ctx: FlightIncidentContext): IncidentTypeOption[] {
  const atBase = isBase(ctx.station);
  const out = INCIDENT_TYPES.filter((t) => t.phases.includes(ctx.phase)).map((type): IncidentTypeOption => {
    if (!type.available) return { type, enabled: false, reason: 'Coming soon' };
    if (type.category === 'airborne') {
      const st = flightStateAt(ctx.flight, ctx.atMs);
      if (!isAirborne(st.phase))
        return { type, enabled: false, reason: 'Only while the aircraft is in the air' };
      if (type.maxProgress !== undefined && st.progress > type.maxProgress)
        return {
          type,
          enabled: false,
          reason: 'Written for early in the flight; the aircraft is well past that',
        };
      if (!arrivalFor(type, ctx))
        return {
          type,
          enabled: false,
          reason: 'No suitable airport within reach other than the destination',
        };
      return { type, enabled: true };
    }
    if (type.category === 'ground' && ctx.nextSectors.length === 0)
      return { type, enabled: false, reason: 'No further flights on this aircraft today' };
    if (type.requires === 'base' && !atBase)
      return {
        type,
        enabled: false,
        reason: `Written for a base with engineers and a spare; ${ctx.station} is an outstation`,
      };
    if (type.requires === 'outstation' && atBase)
      return { type, enabled: false, reason: `Written for an outstation; ${ctx.station} is a base` };
    return { type, enabled: true };
  });
  return out.sort((a, b) => Number(b.enabled) - Number(a.enabled));
}
