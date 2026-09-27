/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** A selected flight's incident context (where the aircraft is, what it still has to fly) and the applicable types. */
import { rotationOf, type DaySchedule, type NetworkFlight, type NetworkTail } from '../schedule';
import { flightStateAt, type FlightPhase } from '../state';
import { isBase } from '../stations';
import { INCIDENT_TYPES, type IncidentType } from './incidentTypes';

export interface FlightIncidentContext {
  schedule: DaySchedule;
  flight: NetworkFlight;
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

export function incidentContext(
  schedule: DaySchedule,
  flightId: string,
  atMs: number,
): FlightIncidentContext | undefined {
  const flight = schedule.flights.find((f) => f.flight === flightId);
  if (!flight) return undefined;
  const tail = schedule.tails.find((t) => t.tail === flight.tail)!;
  const phase = flightStateAt(flight, atMs).phase;
  const arrived = phase === 'landed' || phase === 'at_gate';
  const dayLegs = rotationOf(schedule, flight.tail).filter((f) => !f.cancelled);
  const station = arrived ? flight.to : flight.from;
  const nextSectors = arrived
    ? dayLegs.filter((f) => f.stdMs >= flight.staMs)
    : flight.cancelled
      ? []
      : dayLegs.filter((f) => f.stdMs >= flight.stdMs);
  return { schedule, flight, phase, atMs, tail, station, arrived, nextSectors, dayLegs };
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
