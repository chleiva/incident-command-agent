/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** Integration: the evidence pack exported by the record agent carries the world engine's latest KPI snapshot. */
import { describe, expect, it } from 'vitest';
import { foldEvents, type Scenario } from '@ica/schema';
import { getPublicScenario } from '@ica/scenarios';
import { call, scriptByAgent, step } from '../llm/scripted';
import { makeHarness, ofType } from './__fixtures__/harness';
import { defaultRegistry } from './registry';

const REPORT = { summary: 'done', actionsTaken: [], openIssues: [], recommendations: [], citations: [] };

describe('export_evidence_pack', () => {
  it('attaches the latest KpiSnapshot', async () => {
    const h = await makeHarness({
      scenario: getPublicScenario('s01-pushback-tug-contact') as Scenario,
      registry: defaultRegistry(),
      latencyMs: 30_000, // let the world tick (and compute KPIs) before the export
      script: scriptByAgent({
        orchestrator: [
          step('Record.', call('delegate', { role: 'record', brief: 'Export the evidence pack.' })),
          step('Done.', call('report', REPORT)),
        ],
        record: [
          step('Exporting.', call('export_evidence_pack', {}, 'tu_evp')),
          step('Reporting.', call('report', REPORT)),
        ],
      }),
    });
    await h.run();
    const events = await h.events();
    const res = ofType(events, 'agent.tool_result').find((e) => e.payload.toolCallId === 'tu_evp');
    expect(res?.payload.ok).toBe(true);
    const [pack] = Object.values(foldEvents(events).systems.record.evidencePacks);
    const kpis = pack.contents.kpis as { snapshot: { simMinute: number; delayCostEur: unknown } | null };
    expect(kpis.snapshot).not.toBeNull();
    const lastKpiBefore = ofType(events, 'kpi.update')
      .filter((e) => e.seq < res!.seq)
      .at(-1);
    expect(lastKpiBefore).toBeDefined();
    expect(kpis.snapshot).toEqual(lastKpiBefore!.payload);
  });
});
