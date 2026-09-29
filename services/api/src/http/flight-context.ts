/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * `POST /runs` with a flight context (task 07, async authoring): the server regenerates Accent Air's day from the
 * seed and date and rebuilds the scenario from the flight with the same `@ica/network` templates the browser previews
 * (the client never sends a scenario). Deterministic and fast: no LLM in the request path. Free text is screened with
 * the regex heuristics only and handed to the Run Lambda as an authoring request; the Scenario Author patches the
 * template there, before the world starts (services/run/runtime/authoring.ts).
 *
 * "Something else" (`incidentType: 'other'`) is authoritative free text: the stored scenario is a NEUTRAL base from
 * the flight's context only (no template incident); the Author writes the incident layer from the description and a
 * slice of the day's network. It is never swapped for an unrelated template.
 */
import { generateDaySchedule, type DaySchedule } from '@ica/network';
import {
  OTHER_INCIDENT_TYPE,
  TemplateError,
  buildNeutralScenarioFromFlight,
  buildScenarioFromFlight,
  incidentContext,
  incidentTypeById,
} from '@ica/network/templates';
import {
  validateScenario,
  type AuthoringRequest,
  type CreateRunRequest,
  type Scenario,
  type ScreeningResult,
} from '@ica/schema';
import type { Logger } from '../util/log';
import type { ApiDeps } from './deps';
import { HttpError, badRequest, notFound } from './errors';

const schedules = new Map<string, DaySchedule>();

function scheduleFor(seed: string, date: string): DaySchedule {
  const key = `${seed}|${date}`;
  let s = schedules.get(key);
  if (!s) {
    s = generateDaySchedule(seed, date);
    schedules.set(key, s);
    if (schedules.size > 8) schedules.delete(schedules.keys().next().value!);
  }
  return s;
}

export interface FlightScenarioResult {
  /** The template scenario, already stored (private). */
  scenario: Scenario;
  /** Present when free text was given: the Run Lambda patches the scenario from it. */
  authoring?: AuthoringRequest;
  screening?: ScreeningResult;
}

const rand = () => Math.random().toString(36).slice(2, 6).padEnd(4, '0');

function build(schedule: DaySchedule, flightId: string, typeId: string | undefined, atMs: number) {
  try {
    return typeId
      ? buildScenarioFromFlight(schedule, flightId, typeId, { atMs })
      : buildNeutralScenarioFromFlight(schedule, flightId, { atMs });
  } catch (err) {
    if (err instanceof TemplateError)
      throw new HttpError(err.code === 'flight_not_found' ? 404 : 409, err.code, err.message);
    throw err;
  }
}

export async function buildFlightScenario(
  deps: Pick<ApiDeps, 'store' | 'screen'> & { screenFast?: ApiDeps['screenFast'] },
  req: CreateRunRequest,
  nowMs: number,
  log: Logger,
): Promise<FlightScenarioResult> {
  const fc = req.flightContext!;
  const typeId = req.incidentType;
  if (!typeId) throw badRequest('incidentType is required with flightContext');
  if (Number.isNaN(Date.parse(`${fc.date}T00:00:00Z`)))
    throw badRequest('flightContext.date is not a valid date');
  const schedule = scheduleFor(fc.seed, fc.date);
  const atMs = fc.at ? Date.parse(fc.at) : nowMs;
  const ctx = incidentContext(schedule, fc.flightId, atMs);
  if (!ctx) throw notFound('flight', 'flight_not_found');

  const other = typeId === OTHER_INCIDENT_TYPE;
  if (other && !req.text) throw badRequest("incidentType 'other' needs a text description");
  const type = other ? undefined : incidentTypeById(typeId);
  if (!other && !type) throw badRequest(`unknown incident type '${typeId}'`);

  // Screen first (fast regex only): a rejected description never creates anything.
  let screening: ScreeningResult | undefined;
  if (req.text) {
    screening = await (deps.screenFast ?? deps.screen)(req.text);
    if (screening.verdict === 'rejected')
      throw new HttpError(422, 'input_rejected', 'the text was rejected by input screening', { screening });
  }

  // 'other': a neutral base from the flight's context only; the Author writes the incident (or the run fails).
  const base = build(schedule, fc.flightId, type?.id, atMs);

  const v = validateScenario(base.scenario);
  if (!v.ok) {
    log.error('flight template produced an invalid scenario', {
      typeId,
      flight: fc.flightId,
      errors: v.errors,
    });
    throw new HttpError(500, 'template_invalid', 'the incident template produced an invalid scenario');
  }
  let scenario: Scenario = { ...v.value, visibility: 'private' };
  if (req.text) {
    // A scenario that will be patched must not be shared with another report on the same flight and type.
    const suffix = `-${rand()}`;
    scenario = { ...scenario, id: `${scenario.id.slice(0, 64 - suffix.length)}${suffix}` };
  }
  await deps.store.putScenario(scenario);
  if (!req.text) return { scenario };
  const text = screening?.verdict === 'neutralised' ? (screening.neutralisedText ?? req.text) : req.text;
  const authoring: AuthoringRequest = other
    ? { text, mode: 'other', network: { seed: fc.seed, date: fc.date, flightId: fc.flightId } }
    : { text, label: type!.label, mode: 'typed' };
  return { scenario, authoring, ...(screening ? { screening } : {}) };
}
