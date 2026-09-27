/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** Derived views of a day: where each tail is, the crew's duty margin and a flight's passenger cohorts. */
import { createRng } from './rng';
import { rotationOf, type CrewDuty, type DaySchedule, type NetworkFlight } from './schedule';
import { flightStateAt, flightTimes, isAirborne, type FlightState } from './state';
import { isBase } from './stations';

export interface TailState {
  tail: string;
  /** The flight in progress, or the next one (on the ground), or the last one flown. */
  flight?: NetworkFlight;
  state?: FlightState;
  airborne: boolean;
  /** The station while on the ground. */
  station: string;
}

/** Each tail's situation at an instant. */
export function tailStatesAt(schedule: DaySchedule, tMs: number): TailState[] {
  return schedule.tails.map((t) => {
    const legs = rotationOf(schedule, t.tail).filter((f) => !f.cancelled);
    let station: string = t.base;
    for (const f of legs) {
      const s = flightStateAt(f, tMs);
      if (isAirborne(s.phase)) return { tail: t.tail, flight: f, state: s, airborne: true, station: f.from };
      if (s.phase === 'scheduled' || s.phase === 'boarding' || s.phase === 'taxi_out')
        return { tail: t.tail, flight: f, state: s, airborne: false, station: f.from };
      station = f.to;
    }
    const last = legs.at(-1);
    return {
      tail: t.tail,
      ...(last ? { flight: last, state: flightStateAt(last, tMs) } : {}),
      airborne: false,
      station,
    };
  });
}

/** The crew operating a flight. */
export function crewFor(schedule: DaySchedule, flight: string): CrewDuty | undefined {
  return schedule.crews.find((c) => c.flights.includes(flight));
}

export interface FdpMargin {
  crewId: string;
  report: string;
  sectors: number;
  maxFdpMin: number;
  /** Planned FDP at the crew's last estimated on-blocks. */
  plannedFdpMin: number;
  marginMin: number;
}

/** The flight crew's duty margin, using the current delay estimates (simplified). */
export function fdpMarginFor(schedule: DaySchedule, flight: string): FdpMargin | undefined {
  const crew = crewFor(schedule, flight);
  const last = crew ? schedule.flights.find((f) => f.flight === crew.flights.at(-1)) : undefined;
  if (!crew || !last) return undefined;
  const planned = Math.round((flightTimes(last).inBlockMs - crew.reportMs) / 60_000);
  return {
    crewId: crew.id,
    report: crew.report,
    sectors: crew.sectors,
    maxFdpMin: crew.maxFdpMin,
    plannedFdpMin: planned,
    marginMin: crew.maxFdpMin - planned,
  };
}

export type NetworkCohortKind =
  'general' | 'families' | 'prm' | 'premium' | 'connections' | 'unaccompanied_minors';

export interface NetworkCohort {
  kind: NetworkCohortKind;
  count: number;
  notes?: string;
}

/** A deterministic split of the flight's passengers into cohorts (fictional). */
export function cohortsFor(f: NetworkFlight): NetworkCohort[] {
  const rng = createRng(`cohorts|${f.flight}|${f.std}`);
  const prm = rng.int(1, 5);
  const families = Math.round(f.pax * (0.08 + rng.next() * 0.14));
  const premium = Math.round(f.pax * (0.03 + rng.next() * 0.05));
  const connections = isBase(f.to) ? Math.round(f.pax * (0.03 + rng.next() * 0.07)) : 0;
  const umnr = rng.chance(0.3) ? rng.int(1, 2) : 0;
  const general = Math.max(1, f.pax - prm - families - premium - connections - umnr);
  const out: NetworkCohort[] = [
    { kind: 'general', count: general },
    { kind: 'families', count: families, notes: `${Math.max(1, Math.round(families / 3.5))} family groups` },
    { kind: 'prm', count: prm, notes: 'passengers needing assistance (wheelchair or sensory)' },
    { kind: 'premium', count: premium },
  ];
  if (connections) out.push({ kind: 'connections', count: connections, notes: 'onward connections at base' });
  if (umnr) out.push({ kind: 'unaccompanied_minors', count: umnr });
  return out.filter((c) => c.count > 0);
}
