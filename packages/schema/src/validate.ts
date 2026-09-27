/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** Ajv (JSON Schema 2020-12 + formats) validators for the shared schemas. */
import type { Static, TSchema } from '@sinclair/typebox';
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import {
  EVENT_TYPES,
  EventEnvelopeSchema,
  EventPayloadSchemas,
  type EventType,
  type RunEvent,
} from './events';
import { ScenarioSchema, type Scenario } from './scenario';

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

/** Create a configured Ajv instance (2020-12, all errors, formats). Exported so other packages share settings. */
export function createAjv(): Ajv2020 {
  const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
  (addFormats as unknown as (a: Ajv2020) => void)(ajv);
  return ajv;
}

const ajv = createAjv();

export function formatAjvErrors(errors: ErrorObject[] | null | undefined, prefix = ''): string[] {
  return (errors ?? []).map((e) => {
    const where = `${prefix}${e.instancePath || '/'}`;
    const extra =
      e.keyword === 'additionalProperties'
        ? ` (${String((e.params as { additionalProperty?: string }).additionalProperty)})`
        : e.keyword === 'enum' || e.keyword === 'const'
          ? ` (${JSON.stringify(e.params)})`
          : '';
    return `${where} ${e.message ?? e.keyword}${extra}`;
  });
}

const cache = new WeakMap<object, ValidateFunction>();

/** Compile (cached) and return a typed validator for any TypeBox / JSON schema. */
export function compileSchema<T extends TSchema>(schema: T): (x: unknown) => ValidationResult<Static<T>> {
  let fn = cache.get(schema);
  if (!fn) {
    fn = ajv.compile(JSON.parse(JSON.stringify(schema)));
    cache.set(schema, fn);
  }
  const validateFn = fn;
  return (x: unknown) =>
    validateFn(x)
      ? { ok: true, value: x as Static<T> }
      : { ok: false, errors: formatAjvErrors(validateFn.errors) };
}

const scenarioValidator = compileSchema(ScenarioSchema);

/** Validate a scenario against `scenario.schema.json` plus cross-field checks (unique ids, known tails). */
export function validateScenario(x: unknown): ValidationResult<Scenario> {
  const r = scenarioValidator(x);
  if (!r.ok) return r;
  const s = r.value;
  const errors: string[] = [];
  const dupes = (label: string, ids: string[]) => {
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) errors.push(`/${label} duplicate id '${id}'`);
      seen.add(id);
    }
  };
  dupes(
    'world/engineers',
    s.world.engineers.map((e) => e.id),
  );
  dupes(
    'world/crew',
    s.world.crew.map((c) => c.id),
  );
  dupes(
    'world/cohorts',
    s.world.cohorts.map((c) => c.id),
  );
  dupes(
    'world/stands',
    s.world.stands.map((c) => `${c.station}:${c.id}`),
  );
  dupes(
    'twists',
    s.twists.map((t) => t.id),
  );
  if (s.trigger.atMinute < 0) errors.push('/trigger/atMinute must be ≥ 0');
  if (Number.isNaN(Date.parse(s.startSimTime))) errors.push('/startSimTime is not a valid ISO date-time');
  return errors.length ? { ok: false, errors } : { ok: true, value: s };
}

const envelopeValidator = compileSchema(EventEnvelopeSchema);
const payloadValidators = Object.fromEntries(
  EVENT_TYPES.map((t) => [t, compileSchema(EventPayloadSchemas[t])]),
) as Record<EventType, (x: unknown) => ValidationResult<unknown>>;

export function isEventType(t: unknown): t is EventType {
  return typeof t === 'string' && Object.prototype.hasOwnProperty.call(EventPayloadSchemas, t);
}

/** Validate a full event: envelope + the payload schema for its `type`. Unknown types are rejected. */
export function validateEvent(x: unknown): ValidationResult<RunEvent> {
  const env = envelopeValidator(x);
  if (!env.ok) return env;
  const e = env.value;
  if (!isEventType(e.type)) return { ok: false, errors: [`/type unknown event type '${e.type}'`] };
  const p = payloadValidators[e.type](e.payload);
  if (!p.ok) return { ok: false, errors: p.errors.map((m) => `/payload${m.startsWith('/') ? m : ' ' + m}`) };
  return { ok: true, value: x as RunEvent };
}
