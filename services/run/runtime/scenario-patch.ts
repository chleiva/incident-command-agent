/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Structural validation of a Scenario Author patch (async authoring): the patch schema, every reference against the
 * template (cohort ids, flights, tails, stations, and the twist-effect targets against the template's seeded world),
 * then the merged scenario against the scenario schema. Pure.
 */
import {
  SCENARIO_PATCH_LIMITS,
  ScenarioPatchSchema,
  compileSchema,
  validateScenario,
  type Scenario,
  type ScenarioPatch,
  type SystemState,
} from '@ica/schema';
import {
  NEUTRAL_TRIGGER_TYPE,
  applyAuthoredPatch,
  networkPatchErrors,
  type NetworkSlice,
} from '@ica/network/templates';
import type { Registry } from './registry';
import { hash32, seededRng } from './util';

const validatePatchSchema = compileSchema(ScenarioPatchSchema);

export type PatchCheck =
  { ok: true; scenario: Scenario; patch: ScenarioPatch } | { ok: false; errors: string[] };

export interface TemplateRefs {
  tails: Set<string>;
  flights: Set<string>;
  stations: Set<string>;
  cohorts: Set<string>;
}

/** Identifiers a patch may mention: the template's own (plus, with a network patch, the flights it brings in). */
export function templateRefs(t: Scenario): TemplateRefs {
  const tails = new Set<string>([t.aircraft.tail]);
  const flights = new Set<string>();
  const stations = new Set<string>([t.aircraft.station, t.world.weather.station, t.world.handler.station]);
  for (const s of t.aircraft.nextSectors) {
    flights.add(s.flight);
    stations.add(s.from);
    stations.add(s.to);
  }
  for (const l of t.world.rotation) {
    tails.add(l.tail);
    flights.add(l.flight);
    stations.add(l.from);
    stations.add(l.to);
  }
  for (const x of t.world.spares) {
    tails.add(x.tail);
    stations.add(x.station);
  }
  for (const x of [...t.world.engineers, ...t.world.crew, ...t.world.stands, ...t.world.curfews])
    stations.add(x.station);
  for (const x of t.world.stands) if (x.occupiedByTail) tails.add(x.occupiedByTail);
  for (const c of t.world.cohorts) flights.add(c.flight);
  if (t.airborne) {
    flights.add(t.airborne.flight);
    stations.add(t.airborne.from);
    stations.add(t.airborne.plannedDestination);
  }
  for (const a of t.world.airborneFlights ?? []) {
    flights.add(a.flight);
    tails.add(a.tail);
    stations.add(a.from);
    stations.add(a.plannedDestination);
  }
  return { tails, flights, stations, cohorts: new Set(t.world.cohorts.map((c) => c.id)) };
}

const TAIL_RE = /(?<![A-Za-z0-9])[A-Z]{2}-[A-Z]{3}(?![A-Za-z0-9])/g;
const FLIGHT_RE = /(?<![A-Za-z0-9])ACX\s?\d{3}(?![A-Za-z0-9])/g;
const STATION_KEYS = new Set([
  'station',
  'from',
  'to',
  'destination',
  'plannedDestination',
  'diversionAirport',
]);

/** Every string in `v` with its JSON pointer and the key it sits under. */
function strings(v: unknown, path = '', key = ''): { path: string; key: string; value: string }[] {
  if (typeof v === 'string') return [{ path, key, value: v }];
  if (Array.isArray(v)) return v.flatMap((x, i) => strings(x, `${path}/${i}`, key));
  if (v && typeof v === 'object')
    return Object.entries(v as Record<string, unknown>).flatMap(([k, x]) => strings(x, `${path}/${k}`, k));
  return [];
}

function entityIds(state: SystemState): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const [system, entities] of Object.entries(state))
    for (const [entity, rows] of Object.entries(entities as Record<string, Record<string, unknown>>))
      out.set(`${system}/${entity}`, new Set(Object.keys(rows ?? {})));
  return out;
}

/** The template's seeded world (deterministic): the entity ids twist effects may target. */
export function seededEntityIds(
  template: Scenario,
  registry: Pick<Registry, 'seedAll'>,
): Map<string, Set<string>> {
  return entityIds(registry.seedAll(template, seededRng(hash32(template.id))));
}

/** Compact `system/entity: ids` list for the Author's context (never full entities). */
export function entityIndexText(ids: Map<string, Set<string>>): string {
  return [...ids.entries()]
    .filter(([, s]) => s.size)
    .map(([k, s]) => `${k}: ${[...s].slice(0, 30).join(', ')}`)
    .join('\n');
}

export interface PatchCheckOptions {
  /**
   * `other` ("Something else"): the base is neutral and the patch must write the incident layer (replaceTrigger with
   * a type, and the narrative); up to `twistsOther` twists. `typed` (default): details on a template, ≤ `twists`.
   */
  mode?: 'typed' | 'other';
  /** The day's network slice the Author was given (network-wide events). */
  slice?: NetworkSlice;
}

/** Validate a proposed patch against the template; on success, the merged, schema-valid scenario. */
export function checkScenarioPatch(
  template: Scenario,
  input: unknown,
  registry: Pick<Registry, 'seedAll'>,
  ids?: Map<string, Set<string>>,
  opts: PatchCheckOptions = {},
): PatchCheck {
  const v = validatePatchSchema(input);
  if (!v.ok) return { ok: false, errors: v.errors.slice(0, 20) };
  const patch = v.value as ScenarioPatch;
  const other = opts.mode === 'other';
  const errors: string[] = [];

  if (!other && (patch.twists?.length ?? 0) > SCENARIO_PATCH_LIMITS.twists)
    errors.push(`/twists at most ${SCENARIO_PATCH_LIMITS.twists} extra twists for a typed incident`);
  if (other) {
    if (!patch.replaceTrigger?.type)
      errors.push('/replaceTrigger is required, with a type: write the incident from the description');
    if (!patch.replaceNarrative && !patch.narrative)
      errors.push('/replaceNarrative is required: write the incident from the description');
    if (patch.replaceTrigger?.type === NEUTRAL_TRIGGER_TYPE)
      errors.push(`/replaceTrigger/type "${NEUTRAL_TRIGGER_TYPE}" is the placeholder; name the incident`);
  }
  const twistIds = new Set(template.twists.map((t) => t.id));
  for (const [i, id] of (patch.removeTwistIds ?? []).entries())
    if (!twistIds.has(id)) errors.push(`/removeTwistIds/${i} "${id}" is not a twist of the template`);
  errors.push(...networkPatchErrors(template, patch, opts.slice));
  if (errors.length) return { ok: false, errors: [...new Set(errors)].slice(0, 20) };

  // The world the patch's own twists act on: the template plus the network flights it brings in.
  const world =
    patch.network || patch.commanderDecision
      ? applyAuthoredPatch(
          template,
          {
            ...(patch.network ? { network: patch.network } : {}),
            ...(patch.commanderDecision ? { commanderDecision: patch.commanderDecision } : {}),
          },
          opts.slice,
        )
      : template;
  const refs = templateRefs(world);
  for (const st of opts.slice?.stations ?? []) refs.stations.add(st);
  if (world !== template || !ids) ids = seededEntityIds(world, registry);

  for (const [i, c] of (patch.cohorts ?? []).entries())
    if (!refs.cohorts.has(c.id)) errors.push(`/cohorts/${i}/id "${c.id}" is not a cohort of the template`);

  for (const [i, t] of (patch.twists ?? []).entries()) {
    for (const [j, e] of t.effects.entries()) {
      const at = `/twists/${i}/effects/${j}`;
      if (e.op === 'patch' || e.op === 'shift') {
        const set = ids.get(`${e.system}/${e.entity}`);
        if (!set) errors.push(`${at} unknown entity kind ${e.system}/${e.entity}`);
        else if (!set.has(e.id)) errors.push(`${at}/id "${e.id}" does not exist in ${e.system}/${e.entity}`);
      } else if (e.op === 'create') {
        if (!ids.has(`${e.system}/${e.entity}`))
          errors.push(`${at} unknown entity kind ${e.system}/${e.entity}`);
      } else if (e.op === 'delay') {
        if (!refs.flights.has(e.flight))
          errors.push(`${at}/flight ${e.flight} is not a flight of the template or the network patch`);
      }
    }
  }

  // No invented identifiers anywhere, free text included.
  for (const s of strings(patch)) {
    for (const m of s.value.match(TAIL_RE) ?? [])
      if (!refs.tails.has(m)) errors.push(`${s.path}: tail ${m} is not in the template`);
    for (const m of s.value.match(FLIGHT_RE) ?? []) {
      const f = m.replace(/\s/g, '');
      if (!refs.flights.has(f)) errors.push(`${s.path}: flight ${f} is not in the template`);
    }
    if (STATION_KEYS.has(s.key) && /^[A-Z]{3}$/.test(s.value) && !refs.stations.has(s.value))
      errors.push(`${s.path}: station ${s.value} is not in the template`);
  }
  if (errors.length) return { ok: false, errors: [...new Set(errors)].slice(0, 20) };

  const merged = applyAuthoredPatch(template, patch, opts.slice);
  if (merged.trigger.type === NEUTRAL_TRIGGER_TYPE)
    return {
      ok: false,
      errors: ['/replaceTrigger the incident has not been written (the trigger is the placeholder)'],
    };
  const sv = validateScenario({ ...merged, id: template.id, visibility: template.visibility });
  if (!sv.ok) return { ok: false, errors: sv.errors.slice(0, 20) };
  return { ok: true, scenario: sv.value, patch };
}
