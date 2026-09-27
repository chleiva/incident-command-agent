/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import minimal from '../fixtures/scenario.minimal.json' with { type: 'json' };
import {
  SCENARIO_ID_PATTERN,
  SCENARIO_IDS,
  SHIPPED_SCENARIOS,
  renderScenarioSchemaFile,
  scenarioJsonSchema,
  validateScenario,
} from './index';

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

describe('scenario.schema.json', () => {
  it('is up to date with the TypeBox source (run `npm run -w @ica/schema gen` if this fails)', () => {
    const onDisk = readFileSync(fileURLToPath(new URL('../scenario.schema.json', import.meta.url)), 'utf8');
    expect(onDisk).toBe(renderScenarioSchemaFile());
  });

  it('is plain JSON Schema with schemaVersion 1', () => {
    expect((scenarioJsonSchema.properties as Record<string, { const?: number }>).schemaVersion.const).toBe(1);
  });
});

describe('validateScenario', () => {
  it('accepts the minimal fixture', () => {
    const r = validateScenario(minimal);
    expect(r.ok ? [] : r.errors).toEqual([]);
  });

  it('rejects unknown top-level properties', () => {
    const s = { ...clone(minimal), extra: 1 };
    const r = validateScenario(s);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join('\n')).toContain('extra');
  });

  it('enforces the fictional tail and flight formats', () => {
    const s = clone(minimal);
    s.aircraft.tail = 'G-ABCD';
    s.aircraft.nextSectors[0].flight = 'XY123';
    const r = validateScenario(s);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.startsWith('/aircraft/tail'))).toBe(true);
      expect(r.errors.some((e) => e.startsWith('/aircraft/nextSectors/0/flight'))).toBe(true);
    }
  });

  it('enforces ids, ISO times and ordered pairs', () => {
    const s = clone(minimal) as Record<string, any>;
    s.id = 'Bad Id!';
    s.startSimTime = 'yesterday';
    s.expected.orderedPairs = [['only-one']];
    const r = validateScenario(s);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const all = r.errors.join('\n');
      expect(all).toContain('/id');
      expect(all).toContain('/startSimTime');
      expect(all).toContain('/expected/orderedPairs/0');
    }
  });

  it('rejects duplicate entity ids', () => {
    const s = clone(minimal);
    s.world.engineers.push({ ...s.world.engineers[0] });
    const r = validateScenario(s);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join('\n')).toContain("duplicate id 'eng-1'");
  });
});

describe('fixed scenario ids', () => {
  it('lists the ten shipped ids, all matching the id pattern', () => {
    expect(SCENARIO_IDS).toHaveLength(10);
    expect(SHIPPED_SCENARIOS.map((s) => s.id)).toEqual([...SCENARIO_IDS]);
    for (const id of SCENARIO_IDS) expect(id).toMatch(new RegExp(SCENARIO_ID_PATTERN));
  });
});
