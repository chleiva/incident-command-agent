/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import { CERTIFYING, DUTY_MANAGER, harness } from '../testing';
import { applyMutations } from '../util';
import { recordEngineeringDecision } from '../mne/index';
import { sendMessage } from '../pss/index';
import { addReportDraft, appendTimeline, buildEvidencePack } from './index';

describe('record', () => {
  it('seeds empty', () => {
    const { state } = harness();
    expect(state.record).toEqual({ timeline: {}, reports: {}, evidencePacks: {} });
  });

  it('report drafts are for a human reporter and AI-drafted', () => {
    const h = harness();
    const r = addReportDraft(h.state, { kind: 'occurrence', body: 'Draft MOR.' }, 20, h.rng);
    expect(r.ok && r.value).toMatchObject({
      status: 'draft',
      forHumanReporter: true,
      aiDrafted: true,
      createdAtMinute: 20,
    });
    expect(addReportDraft(h.state, { kind: 'discretion', body: '  ' }, 20, h.rng).ok).toBe(false);
  });

  it('evidence pack gathers timeline, decisions with approvers, messages sent, reports and citations', () => {
    const h = harness();
    const steps = [
      appendTimeline(h.state, { atMinute: 3, text: 'Incident opened', source: 'orchestrator' }, h.rng),
      recordEngineeringDecision(
        h.state,
        { tail: 'NW-FXA', decision: 'rectify' },
        CERTIFYING,
        'Replace sensor',
        10,
        h.rng,
      ),
      sendMessage(
        h.state,
        { cohortIds: ['c-general'], body: 'Delayed; update at 06:30.' },
        11,
        DUTY_MANAGER,
        h.rng,
      ),
      addReportDraft(h.state, { kind: 'occurrence', body: 'Draft MOR.' }, 20, h.rng),
    ];
    for (const s of steps) h.state = applyMutations(h.state, s.ok ? s.mutations : []);
    const p = buildEvidencePack(h.state, 30, ['mmel-52-10-01#1', 'mmel-52-10-01#1'], h.rng);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    const c = p.value.contents;
    expect(c.timeline).toHaveLength(1);
    expect(c.decisions).toEqual([
      expect.objectContaining({ kind: 'engineering', decidedBy: 'Ada Pennick (Certifying Engineer (B1))' }),
    ]);
    expect(c.messages).toEqual([
      expect.objectContaining({ approvedBy: 'Sol Varden (Duty Manager)', aiDrafted: true }),
    ]);
    expect(c.reports).toHaveLength(1);
    expect(c.citations).toEqual([{ chunkId: 'mmel-52-10-01#1' }]);
    expect(p.mutations[0]).toMatchObject({ system: 'record', entity: 'evidencePacks', op: 'create' });
  });
});
