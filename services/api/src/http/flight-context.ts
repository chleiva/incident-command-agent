/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * `POST /runs` with a flight context (task 07): the server regenerates Accent Air's day from the seed and date,
 * rebuilds the scenario from the flight with the same `@ica/network` templates the browser previews (the client
 * never sends a scenario), optionally runs the Scenario Author on the duty manager's free text (screened inside the
 * Author path, seeded with the flight's context), validates the result and stores it as a private scenario.
 */
import { generateDaySchedule, type DaySchedule } from '@ica/network';
import {
  OTHER_INCIDENT_TYPE,
  TemplateError,
  authorRequestText,
  buildScenarioFromFlight,
  incidentContext,
  incidentTypeById,
  type BuiltScenario,
} from '@ica/network/templates';
import { validateScenario, type CreateRunRequest, type CreateRunResponse, type Scenario } from '@ica/schema';
import { errorFields, type Logger } from '../util/log';
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
  scenario: Scenario;
  extra: Pick<CreateRunResponse, 'screening' | 'authorFallback'>;
}

const rand = () => Math.random().toString(36).slice(2, 6).padEnd(4, '0');

export async function buildFlightScenario(
  deps: Pick<ApiDeps, 'author' | 'store'>,
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

  let base: BuiltScenario | undefined;
  const type = typeId === OTHER_INCIDENT_TYPE ? undefined : incidentTypeById(typeId);
  if (typeId !== OTHER_INCIDENT_TYPE) {
    if (!type) throw badRequest(`unknown incident type '${typeId}'`);
    try {
      base = buildScenarioFromFlight(schedule, fc.flightId, typeId, { atMs });
    } catch (err) {
      if (err instanceof TemplateError)
        throw new HttpError(err.code === 'flight_not_found' ? 404 : 409, err.code, err.message);
      throw err;
    }
    const v = validateScenario(base.scenario);
    if (!v.ok) {
      log.error('flight template produced an invalid scenario', {
        typeId,
        flight: fc.flightId,
        errors: v.errors,
      });
      throw new HttpError(500, 'template_invalid', 'the incident template produced an invalid scenario');
    }
  } else if (!req.text) {
    throw badRequest("incidentType 'other' needs a text description");
  }

  let scenario: Scenario | undefined = base?.scenario;
  const extra: FlightScenarioResult['extra'] = {};
  if (req.text) {
    try {
      const result = await deps.author.author(authorRequestText(ctx, type, req.text, base));
      extra.screening = result.screening;
      if (result.screening?.verdict === 'rejected')
        throw new HttpError(422, 'input_rejected', 'the text was rejected by input screening', {
          screening: result.screening,
        });
      const v = result.scenario ? validateScenario({ ...result.scenario, visibility: 'private' }) : null;
      if (v?.ok) {
        const id = `fc-${fc.date}-${fc.flightId.toLowerCase()}-${rand()}`;
        scenario = { ...v.value, id, visibility: 'private' };
      } else if (base) {
        extra.authorFallback = true;
        log.warn('author scenario invalid; using the template', {
          errors: v?.ok === false ? v.errors : result.errors,
        });
      } else {
        throw new HttpError(422, 'author_invalid', 'the Scenario Author could not build a valid scenario', {
          errors: v?.ok === false ? v.errors : (result.errors ?? []),
        });
      }
    } catch (err) {
      if (err instanceof HttpError) throw err;
      if (!base) throw new HttpError(502, 'author_failed', 'the Scenario Author failed');
      // The template scenario stands on its own; the (unscreened) text is not used.
      log.warn('author unavailable; using the template', errorFields(err));
      extra.authorFallback = true;
    }
  }
  if (!scenario) throw new HttpError(500, 'no_scenario', 'no scenario could be built');
  await deps.store.putScenario(scenario);
  return { scenario, extra };
}
