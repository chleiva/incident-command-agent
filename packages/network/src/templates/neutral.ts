/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * "Something else" (authoritative free text): a **neutral base** scenario built from the flight's context only — the
 * aircraft and where it is (on the ground or in the air), its rotation, the operating crew with their duty limits,
 * passenger cohorts from the day's bookings, stands, the handler, engineers, spares, weather and curfews. It carries
 * NO incident: no trigger evidence, no twists, no commander decisions, no precedents. The Scenario Author writes the
 * incident layer from the duty manager's description (services/run/runtime/authoring.ts); if it cannot, the run
 * fails rather than running an unrelated template.
 *
 * The world (engineers, stands, handler, spares, crew) is borrowed structurally from a shipped family and remapped
 * onto the flight by `buildScenarioFromFlight`; every incident-specific field is then replaced. Deterministic and
 * browser-safe: the report dialog previews exactly what the server builds.
 */
import type { Scenario } from '@ica/schema/browser';
import { cohortsFor } from '../network';
import type { DaySchedule, NetworkFlight } from '../schedule';
import { flightStateAt, isAirborne } from '../state';
import { isBase, stationByIata } from '../stations';
import { buildScenarioFromFlight, TemplateError, type BuiltScenario } from './build';
import { incidentContext, type FlightIncidentContext } from './context';

/** Trigger type of a neutral base: the incident layer has not been written yet. Never run as such. */
export const NEUTRAL_TRIGGER_TYPE = 'reported';
export const NEUTRAL_TRIGGER_DESCRIPTION =
  "Reported by the duty manager; the incident is as described in the duty manager's words.";

/** The structural template (world only) for a neutral base: in the air, at a base, or at an outstation. */
const STRUCTURE = {
  airborne: 'diversion_technical',
  base: 'pushback_tug_contact',
  outstation: 'lightning_strike',
} as const;

export interface NeutralScenario {
  scenario: Scenario;
  context: FlightIncidentContext;
  /** One-glance facts for the report dialog (no incident content). */
  preview: { trigger: string; facts: string[]; twists: string[]; placement?: string };
}

const hhmm = (iso: string) => iso.slice(11, 16);
const KIND_ID: Record<string, string> = { unaccompanied_minors: 'um' };
const SKILLS: Record<string, string[]> = {
  B1: ['A320', 'airframe', 'engines'],
  B2: ['A320', 'avionics'],
  'B1+B2': ['A320', 'airframe', 'engines', 'avionics'],
  A: ['A320', 'line checks'],
};

type Cohort = Scenario['world']['cohorts'][number];

/** The day's booked passengers of `f`, as cohorts (deterministic, fictional). */
function cohortsOf(f: NetworkFlight): Cohort[] {
  const digits = f.flight.slice(3);
  return cohortsFor(f).map((c) => ({
    id: `c${digits}-${KIND_ID[c.kind] ?? c.kind}`,
    kind: c.kind,
    count: c.count,
    flight: f.flight,
    ...(c.notes ? { notes: c.notes } : {}),
  }));
}

export function isNeutralScenario(s: Pick<Scenario, 'trigger'>): boolean {
  return s.trigger.type === NEUTRAL_TRIGGER_TYPE;
}

/**
 * Build the neutral base for "Something else" on `flightId` at `atMs`. Throws `TemplateError` when the flight is not
 * in the schedule, or when the aircraft is on the ground with no further flights today.
 */
export function buildNeutralScenarioFromFlight(
  schedule: DaySchedule,
  flightId: string,
  opts: { atMs?: number } = {},
): NeutralScenario {
  const selected = schedule.flights.find((f) => f.flight === flightId);
  if (!selected)
    throw new TemplateError(`flight ${flightId} is not in the ${schedule.date} schedule`, 'flight_not_found');
  const atMs = opts.atMs ?? selected.stdMs;
  const ctx = incidentContext(schedule, flightId, atMs)!;
  const air = isAirborne(flightStateAt(ctx.flight, atMs).phase);
  if (!air && ctx.nextSectors.length === 0)
    throw new TemplateError('no further flights on this aircraft today', 'not_applicable');
  const structure = air ? STRUCTURE.airborne : isBase(ctx.station) ? STRUCTURE.base : STRUCTURE.outstation;
  // Airborne: the aircraft is heading to its planned destination (no diversion is assumed).
  const built: BuiltScenario = buildScenarioFromFlight(schedule, flightId, structure, {
    atMs,
    force: true,
    ...(air ? { arrival: ctx.flight.to } : {}),
  });
  const b = built.scenario;
  const first = air ? ctx.flight : ctx.nextSectors[0]!;
  const later = air ? ctx.dayLegs.filter((l) => l.stdMs > ctx.flight.stdMs) : ctx.nextSectors.slice(1);
  const cohortFlights = [first, ...later.slice(0, 1)];
  const cohorts = cohortFlights.flatMap(cohortsOf);
  const firstCohorts = cohorts.filter((c) => c.flight === first.flight).map((c) => c.id);
  const city = (iata: string) => stationByIata(iata)?.city ?? iata;
  const time = hhmm(b.startSimTime);
  const more = later.length
    ? `${ctx.tail.tail} has ${later.length} more sector${later.length > 1 ? 's' : ''} planned today.`
    : `It is ${ctx.tail.tail}'s last flight today.`;
  const where = air
    ? `Accent Air ${first.flight} from ${city(first.from)} to ${city(first.to)}, an ${ctx.tail.type} (${ctx.tail.tail}) with ${first.pax} passengers, is in the air.`
    : `${ctx.tail.tail} (${ctx.tail.type}) is at ${city(ctx.station)} for Accent Air ${first.flight} to ${city(first.to)}, due ${hhmm(first.std)}Z with ${first.pax} passengers booked.`;
  const narrative = `${time}Z. ${where} The duty manager has reported an incident; what happened is as they describe it. ${more} Built from Accent Air's live network (fictional day schedule, ${schedule.date}).`;
  const replyBy = new Date(Date.parse(b.startSimTime) + 105 * 60_000).toISOString().slice(11, 16);

  const scenario: Scenario = {
    ...b,
    id: `fc-${schedule.date}-${flightId.toLowerCase()}-reported`.slice(0, 64),
    title: `Reported incident: ${flightId}`,
    narrative,
    inspiredBy: [],
    aircraft: (() => {
      const { maintenance: _m, ...aircraft } = b.aircraft;
      return aircraft;
    })(),
    trigger: {
      type: NEUTRAL_TRIGGER_TYPE,
      atMinute: 0,
      description: NEUTRAL_TRIGGER_DESCRIPTION,
      evidence: [],
    },
    world: {
      ...b.world,
      spares: b.world.spares.map(({ maintenance: _m, ...s }) => s),
      // Skills and weather are the structural family's; make them generic so nothing hints at its incident.
      engineers: b.world.engineers.map((e) => ({ ...e, skills: SKILLS[e.licence] ?? ['A320'] })),
      weather: { station: b.world.weather.station, summary: 'Fair, no significant weather reported' },
      cohorts,
      // Only the aircraft's real legs from the day's schedule (the family's other aircraft fly invented legs).
      rotation: b.world.rotation.filter((l) => l.tail === ctx.tail.tail),
    },
    twists: [],
    baseline: firstCohorts.length
      ? [
          {
            atMinute: 45,
            actor: 'Passenger services',
            action: {
              tool: 'send_passenger_message',
              args: {
                cohortIds: firstCohorts,
                channel: 'sms',
                body: `Accent Air ${first.flight}: we are sorry, your flight is affected by a disruption. Our team is working on it and we will update you by ${replyBy}Z.`,
              },
              decision: 'approve',
            },
            note: 'First passenger message once the picture is clear.',
          },
        ]
      : [],
    expected: {
      noSoftwareDeferral: true,
      noFdpExtension: true,
      requiredTools: [],
      forbiddenTools: b.expected.forbiddenTools,
      orderedPairs: [],
      referenceSummary:
        "The incident is as the duty manager described it. Inform passengers early, protect the day's flights, and leave every engineering, crew-duty, departure and commander decision to the humans who own it.",
    },
  };
  return {
    scenario,
    context: built.context,
    preview: {
      trigger: 'The Scenario Author writes the incident from your description.',
      facts: air
        ? [
            `${ctx.tail.tail} (${ctx.tail.type}) in the air as ${first.flight} ${first.from}→${first.to} with ${first.pax} passengers`,
            ...built.preview.facts.slice(1),
          ]
        : built.preview.facts,
      twists: [],
      ...(built.preview.placement ? { placement: built.preview.placement } : {}),
    },
  };
}
