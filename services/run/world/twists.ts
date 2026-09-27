/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** Twist effects → mock-state mutations (pure). Entities are schema-checked so a twist can't corrupt state. */
import {
  ENTITY_KEY,
  SYSTEM_ENTITY_SCHEMAS,
  TwistEffectSchema,
  compileSchema,
  type SystemMutation,
  type SystemState,
  type TwistEffect,
} from '@ica/schema';
import { deepClone } from '../runtime/util';
import { etdMin, retimeFlight } from '../systems/occ/index';
import { originMs } from '../systems/util';

export interface AppliedTwist {
  mutations: SystemMutation[];
  infos: string[];
  errors: string[];
}

type Loose = Record<string, Record<string, Record<string, Record<string, unknown>>>>;

const entityValidators = new Map<string, (x: unknown) => { ok: boolean; errors?: string[] }>();

function validateEntity(system: string, entity: string, value: unknown): string[] {
  const key = `${system}/${entity}`;
  let v = entityValidators.get(key);
  if (!v) {
    const schema = (SYSTEM_ENTITY_SCHEMAS as Record<string, Record<string, unknown>>)[system]?.[entity];
    if (!schema) return [`unknown entity ${key}`];
    const c = compileSchema(schema as never);
    v = (x) => {
      const r = c(x);
      return r.ok ? { ok: true } : { ok: false, errors: r.errors };
    };
    entityValidators.set(key, v);
  }
  const r = v(value);
  return r.ok ? [] : (r.errors ?? ['invalid']);
}

const effectValidator = compileSchema(TwistEffectSchema);

export function isValidTwistEffect(x: unknown): x is TwistEffect {
  return effectValidator(x).ok;
}

/**
 * Apply effects in order against a working copy of the state (later effects see earlier ones). `now` (sim minute)
 * lets a `shift` skip a time that has already passed (an engineer already on site cannot be delayed).
 */
export function applyTwistEffects(state: SystemState, effects: TwistEffect[], now?: number): AppliedTwist {
  const work = deepClone(state) as unknown as Loose;
  const out: AppliedTwist = { mutations: [], infos: [], errors: [] };
  for (const eff of effects) {
    if (eff.op === 'info') {
      out.infos.push(eff.text);
      continue;
    }
    if (eff.op === 'delay') {
      const f = work.occ?.flights?.[eff.flight];
      if (!f) {
        out.errors.push(`delay: unknown flight ${eff.flight}`);
        continue;
      }
      // Same delay model as the occ system (which owns delays): re-time the ETD and propagate reactionary delay
      // down the tail's rotation. States without sim-minute anchors (test doubles) get a plain delay patch.
      const typed = work as unknown as SystemState;
      if (originMs(typed) !== undefined && eff.minutes > 0) {
        const flight = typed.occ.flights[eff.flight];
        const ms = retimeFlight(typed, eff.flight, etdMin(typed, flight) + eff.minutes);
        for (const m of ms) (work.occ.flights as Record<string, unknown>)[m.id] = deepClone(m.after);
        out.mutations.push(...ms);
        continue;
      }
      const before = deepClone(f);
      const after = {
        ...f,
        delayMin: Math.max(0, Number(f.delayMin ?? 0) + eff.minutes),
        status: f.status === 'scheduled' || f.status === 'boarding' ? 'delayed' : f.status,
      };
      work.occ.flights[eff.flight] = after;
      out.mutations.push({ system: 'occ', entity: 'flights', id: eff.flight, op: 'update', before, after });
      continue;
    }
    if (eff.op === 'shift') {
      const cur = work[eff.system]?.[eff.entity]?.[eff.id];
      const v = cur?.[eff.field];
      if (!cur || typeof v !== 'number') {
        out.errors.push(`shift: ${eff.system}/${eff.entity}/${eff.id} has no numeric '${eff.field}'`);
        continue;
      }
      if (now !== undefined && v <= now) {
        out.errors.push(
          `shift: ${eff.system}/${eff.entity}/${eff.id}.${eff.field} (${v}) has already passed`,
        );
        continue;
      }
      const after = { ...cur, [eff.field]: v + eff.minutes };
      const errs = validateEntity(eff.system, eff.entity, after);
      if (errs.length) {
        out.errors.push(`shift ${eff.system}/${eff.entity}/${eff.id}: ${errs.join('; ')}`);
        continue;
      }
      work[eff.system]![eff.entity]![eff.id] = after;
      out.mutations.push({
        system: eff.system,
        entity: eff.entity,
        id: eff.id,
        op: 'update',
        before: deepClone(cur),
        after,
      });
      continue;
    }
    const keyField = (ENTITY_KEY as Record<string, Record<string, string>>)[eff.system]?.[eff.entity];
    if (!keyField) {
      out.errors.push(`${eff.op}: unknown entity ${eff.system}/${eff.entity}`);
      continue;
    }
    const map = ((work[eff.system] ??= {})[eff.entity] ??= {});
    if (eff.op === 'patch') {
      const cur = map[eff.id];
      if (!cur) {
        out.errors.push(`patch: unknown ${eff.system}/${eff.entity} '${eff.id}'`);
        continue;
      }
      const after = { ...cur, ...eff.patch, [keyField]: eff.id };
      const errs = validateEntity(eff.system, eff.entity, after);
      if (errs.length) {
        out.errors.push(`patch ${eff.system}/${eff.entity}/${eff.id}: ${errs.join('; ')}`);
        continue;
      }
      map[eff.id] = after;
      out.mutations.push({
        system: eff.system,
        entity: eff.entity,
        id: eff.id,
        op: 'update',
        before: deepClone(cur),
        after,
      });
    } else {
      const id = eff.record[keyField];
      if (typeof id !== 'string' || !id) {
        out.errors.push(`create ${eff.system}/${eff.entity}: record has no '${keyField}'`);
        continue;
      }
      const errs = validateEntity(eff.system, eff.entity, eff.record);
      if (errs.length) {
        out.errors.push(`create ${eff.system}/${eff.entity}/${id}: ${errs.join('; ')}`);
        continue;
      }
      const existed = map[id];
      map[id] = deepClone(eff.record);
      out.mutations.push({
        system: eff.system,
        entity: eff.entity,
        id,
        op: existed ? 'update' : 'create',
        ...(existed ? { before: deepClone(existed) } : {}),
        after: deepClone(eff.record),
      });
    }
  }
  return out;
}

/** Human-readable text of a twist for agents (`<twist_data>`). */
export function twistNoticeText(description: string, infos: string[]): string {
  return [description, ...infos].filter(Boolean).join('\n');
}
