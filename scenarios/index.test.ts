/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateScenario } from '@ica/schema';
import { getPublicScenario, publicScenarios } from './index';
import { INDEX_FILE, PUBLIC_DIR, listJson, renderIndex } from './scripts/index-gen';

describe('@ica/scenarios', () => {
  it('index.gen.ts is up to date (run `npm run scenarios:validate`)', () => {
    expect(readFileSync(INDEX_FILE, 'utf8')).toBe(renderIndex(listJson(PUBLIC_DIR)));
  });

  it('every public scenario is schema-valid with a unique id', () => {
    expect(publicScenarios.length).toBeGreaterThan(0);
    const ids = new Set<string>();
    for (const s of publicScenarios) {
      const r = validateScenario(s);
      expect(r.ok ? [] : [s.id, ...r.errors]).toEqual([]);
      expect(ids.has(s.id)).toBe(false);
      ids.add(s.id);
    }
  });

  it('looks scenarios up by id', () => {
    const first = publicScenarios[0];
    expect(getPublicScenario(first.id)).toBe(first);
    expect(getPublicScenario('nope')).toBeUndefined();
  });
});
