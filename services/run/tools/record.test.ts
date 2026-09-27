/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import { DUTY_MANAGER } from '../systems/testing';
import { call, fixtureHarness, okData } from './_testing';

const BODY =
  'At 05:32 UTC on stand 22 at MAN, NW-FXA showed an intermittent FWD CARGO DOOR caution during boarding of NWD101. Engineers were paged; passengers were informed at 05:41.';

describe('record tools', () => {
  it('append_timeline defaults to now and source record', async () => {
    const h = await fixtureHarness();
    h.simMinute = 4;
    const e = okData(await call(h, 'append_timeline', { text: 'Incident opened by the orchestrator' })).entry;
    expect(e).toMatchObject({ atMinute: 4, source: 'record' });
  });

  it('occurrence and discretion drafts are for a human reporter and AI-drafted', async () => {
    const h = await fixtureHarness();
    expect(okData(await call(h, 'draft_occurrence_report', { body: BODY })).report).toMatchObject({
      kind: 'occurrence',
      forHumanReporter: true,
      aiDrafted: true,
    });
    expect(okData(await call(h, 'draft_discretion_report', { body: BODY })).report.kind).toBe('discretion');
    expect(
      Object.values(h.state.record.reports).every((r) => r.forHumanReporter && r.status === 'draft'),
    ).toBe(true);
  });

  it('export_evidence_pack collects decisions with approvers, messages and citations', async () => {
    const h = await fixtureHarness();
    await call(h, 'append_timeline', { text: 'Incident opened' });
    await call(
      h,
      'propose_swap',
      { fromTail: 'NW-FXA', toTail: 'NW-FXB', flights: ['NWD101'] },
      { approvedBy: DUTY_MANAGER },
    );
    await call(
      h,
      'send_passenger_message',
      {
        cohortIds: ['c-general'],
        channel: 'sms',
        body: 'Your flight is delayed; next update by 06:30 at the gate.',
      },
      { approvedBy: DUTY_MANAGER },
    );
    const p = okData(await call(h, 'export_evidence_pack', { citedChunkIds: ['mmel-52-30-04#1'] }));
    expect(p.counts).toEqual({ timeline: 1, decisions: 1, messages: 1, reports: 0, citations: 1 });
    const pack = h.state.record.evidencePacks[p.evidencePackId];
    expect((pack.contents.decisions as any[])[0]).toMatchObject({
      kind: 'swap',
      decidedBy: 'Sol Varden (Duty Manager)',
    });
  });
});
