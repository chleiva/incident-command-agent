/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import { AGENT_ROLES, STATE_SYSTEM_NAMES, SYSTEM_ENTITIES } from '@ica/schema';
import minimal from '@ica/schema/fixtures/scenario.minimal.json' with { type: 'json' };
import type { Scenario } from '@ica/schema';
import {
  domainTools,
  executeRun,
  loadKnowledgeIndex,
  roles,
  runAuthor,
  screenInput,
  seedAll,
  systems,
} from './index';
import { handler } from './handler';

describe('@ica/run registry stubs (task 01 contract)', () => {
  it('exports the registries with the agreed names', () => {
    expect(Array.isArray(domainTools)).toBe(true);
    expect(Array.isArray(systems)).toBe(true);
    expect(Object.keys(roles).sort()).toEqual([...AGENT_ROLES].sort());
    for (const r of AGENT_ROLES) {
      expect(roles[r].role).toBe(r);
      expect(roles[r].stop).toBe('report_tool');
    }
  });

  it('seedAll returns every system with every entity map', () => {
    const state = seedAll(minimal as unknown as Scenario, () => 0.5);
    expect(Object.keys(state).sort()).toEqual([...STATE_SYSTEM_NAMES].sort());
    for (const [sys, entities] of Object.entries(SYSTEM_ENTITIES)) {
      expect(Object.keys((state as Record<string, object>)[sys]).sort()).toEqual([...entities].sort());
    }
  });

  it('knowledge stub returns no hits; screenInput stub is clean', async () => {
    const idx = await loadKnowledgeIndex({ source: 'fs', path: 'data/fixtures' });
    expect(await idx.search({ query: 'mel' })).toEqual([]);
    expect(await screenInput('hello')).toEqual({ verdict: 'clean', findings: [] });
  });

  it('entry points are implemented (task 02) and validate their inputs', async () => {
    const { MemoryStore } = await import('@ica/store');
    const store = new MemoryStore();
    await expect(executeRun({ runId: 'x', deps: { store } as never })).rejects.toThrow(/run not found/);
    expect(typeof runAuthor).toBe('function');
    await expect(handler({} as never)).rejects.toThrow(/runId/);
  });
});
