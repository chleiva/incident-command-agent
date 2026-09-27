/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import { foldEvents, validateEvent } from '@ica/schema';
import { demoScript } from './demo-script';
import { makeHarness, ofType } from './__fixtures__/harness';

describe('end-to-end smoke (scripted demo, fake registry)', () => {
  it('produces a schema-valid event log that folds without errors', async () => {
    const h = await makeHarness({ script: demoScript() });
    const result = await h.run();
    const events = await h.events();
    expect(result.status).toBe('completed');
    expect(result.reason).toBe('report');
    for (const e of events) expect(validateEvent(e).ok).toBe(true);
    const seqs = events.map((e) => e.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
    const p = foldEvents(events);
    expect(p.meta.status).toBe('completed');
    expect(
      ofType(events, 'agent.report')
        .map((e) => e.payload.role)
        .sort(),
    ).toEqual(['maintenance', 'orchestrator', 'passenger']);
    expect(ofType(events, 'guardrail.blocked').some((e) => e.payload.layer === 'tier')).toBe(true);
    expect(ofType(events, 'approval.decision')).toHaveLength(1);
    expect(p.systems.record.timeline).toBeDefined();
    expect(Object.keys(p.systems.record.timeline).length).toBeGreaterThanOrEqual(3);
    expect(ofType(events, 'world.tick').length).toBeGreaterThan(0);
    expect(ofType(events, 'kpi.update').length).toBeGreaterThan(0);
  });
});
