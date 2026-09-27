/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import { STATE_SYSTEM_NAMES, SYSTEM_ENTITIES, SYSTEM_ENTITY_SCHEMAS, compileSchema } from '@ica/schema';
import { seededRng } from './names';
import { harness } from './testing';
import { knownRefs, seedAll, systems, tickAll } from './index';
import { applyMutations } from './util';

const validators = Object.fromEntries(
  Object.entries(SYSTEM_ENTITY_SCHEMAS).map(([sys, ents]) => [
    sys,
    Object.fromEntries(Object.entries(ents).map(([e, schema]) => [e, compileSchema(schema as never)])),
  ]),
) as Record<string, Record<string, (x: unknown) => { ok: boolean; errors?: string[] }>>;

function assertValid(state: Record<string, Record<string, Record<string, unknown>>>) {
  for (const [sys, ents] of Object.entries(state))
    for (const [e, map] of Object.entries(ents))
      for (const [id, entity] of Object.entries(map)) {
        const r = validators[sys][e](entity);
        expect(r.ok ? [] : [sys, e, id, ...(r.errors ?? [])]).toEqual([]);
      }
}

describe('systems registry', () => {
  it('registers the seven systems plus record', () => {
    expect(systems.map((s) => s.name).sort()).toEqual([...STATE_SYSTEM_NAMES].sort());
  });

  it('seedAll is deterministic, complete and schema-valid', () => {
    const h = harness();
    const a = seedAll(h.scenario, seededRng(5));
    const b = seedAll(h.scenario, seededRng(5));
    expect(a).toEqual(b);
    for (const [sys, entities] of Object.entries(SYSTEM_ENTITIES))
      expect(Object.keys((a as any)[sys]).sort()).toEqual([...entities].sort());
    assertValid(a as never);
  });

  it('three simulated hours of ticks only produce schema-valid full entities', () => {
    const h = harness();
    let s = h.state;
    for (let m = 1; m <= 180; m++) {
      const ms = tickAll(s, m, 1);
      for (const x of ms) expect(x.after).toBeDefined();
      s = applyMutations(s, ms);
    }
    assertValid(s as never);
    // the unserviceable aircraft has kept slipping its first flight
    expect(s.occ.flights.ACX101.delayMin).toBeGreaterThan(100);
  });

  it('knownRefs lists every referenceable id', () => {
    const refs = knownRefs(harness().state);
    expect(refs.tail).toEqual(expect.arrayContaining(['AX-FXA', 'AX-FXB']));
    expect(refs.flight).toEqual(expect.arrayContaining(['ACX101', 'ACX102']));
    expect(refs.cohort).toEqual(['c-connections', 'c-general', 'c-prm']);
    expect(refs.engineer).toEqual(['eng-1', 'eng-2']);
    expect(refs.stand).toEqual(['22', '24', 'R5']);
    expect(refs.defect).toEqual(['DEF-001']);
    expect(refs.station).toContain('MAN');
    expect(refs.crew).toHaveLength(3);
  });
});
