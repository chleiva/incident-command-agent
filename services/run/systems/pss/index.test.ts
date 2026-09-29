/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import { DUTY_MANAGER, harness } from '../testing';
import { applyMutations } from '../util';
import { retimeFlight } from '../occ/index';
import {
  draftMessage,
  estimateExposure,
  eu261TierEur,
  issueVouchers,
  rebookCohort,
  sendMessage,
} from './index';

describe('pss EU261 tiers', () => {
  it('≤1500 km €250; intra-EU >1500 or 1500–3500 km €400; otherwise €600', () => {
    expect(eu261TierEur(265, true)).toBe(250);
    expect(eu261TierEur(1500, false)).toBe(250);
    expect(eu261TierEur(1501, false)).toBe(400);
    expect(eu261TierEur(3500, false)).toBe(400);
    expect(eu261TierEur(4000, true)).toBe(400);
    expect(eu261TierEur(4000, false)).toBe(600);
  });

  it('exposure only once the projected arrival delay reaches 3 h', () => {
    const h = harness();
    const before = estimateExposure(h.state, h.scenario, undefined);
    expect(before.ok && before.value).toMatchObject({ totalEur: 0, minutesTo3h: 180 });
    const late = applyMutations(h.state, retimeFlight(h.state, 'ACX101', 40 + 185));
    const after = estimateExposure(late, h.scenario, ['c-general']);
    expect(after.ok && after.value.lines[0]).toMatchObject({
      tierEur: 250,
      compensationEligible: true,
      exposureEur: 140 * 250,
    });
  });
});

describe('pss rebooking', () => {
  it('generates fictional ACX options on the affected route', () => {
    const { state } = harness();
    const opts = Object.values(state.pss.rebookingOptions);
    expect(opts.length).toBeGreaterThanOrEqual(2);
    for (const o of opts) {
      expect(o.flight).toMatch(/^ACX[1-9]\d{2}$/);
      expect(o).toMatchObject({ from: 'MAN', to: 'DUB' });
    }
  });

  it('rebooks only onto flights with enough seats, decrementing them', () => {
    const h = harness();
    const [opt] = Object.values(h.state.pss.rebookingOptions);
    const tooBig = rebookCohort(h.state, 'c-general', opt.flight);
    expect(tooBig.ok).toBe(false); // 140 passengers never fit a generated option (≤ 48 seats)
    const r = rebookCohort(h.state, 'c-prm', opt.flight);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const s = applyMutations(h.state, r.mutations);
    expect(s.pss.rebookingOptions[opt.flight].seatsAvailable).toBe(opt.seatsAvailable - 4);
    expect(s.pss.cohorts['c-prm']).toMatchObject({ status: 'rebooked', rebookedTo: opt.flight });
    expect(rebookCohort(s, 'c-prm', opt.flight).ok).toBe(false);
    expect(rebookCohort(h.state, 'c-prm', 'ACX999').ok).toBe(false);
  });
});

describe('pss messages and care', () => {
  it('drafts carry aiDrafted; sending sets sentAtMinute and firstInformedAtMinute once', () => {
    const h = harness();
    const d = draftMessage(
      h.state,
      { cohortIds: ['c-general', 'c-prm'], channel: 'sms', body: 'Update at 06:30.' },
      h.rng,
    );
    expect(d.ok && d.value).toMatchObject({ status: 'draft', aiDrafted: true });
    if (!d.ok) return;
    let s = applyMutations(h.state, d.mutations);
    const sent = sendMessage(s, { messageId: d.value.id }, 12, DUTY_MANAGER, h.rng);
    expect(sent.ok && sent.value).toMatchObject({
      status: 'sent',
      sentAtMinute: 12,
      approvedBy: DUTY_MANAGER,
    });
    if (!sent.ok) return;
    s = applyMutations(s, sent.mutations);
    expect(s.pss.cohorts['c-general']).toMatchObject({ status: 'informed', firstInformedAtMinute: 12 });
    expect(s.pss.cohorts['c-connections'].status).toBe('uninformed');
    const again = sendMessage(
      s,
      { cohortIds: ['c-general'], body: 'Second update.' },
      30,
      DUTY_MANAGER,
      h.rng,
    );
    s = applyMutations(s, again.ok ? again.mutations : []);
    expect(s.pss.cohorts['c-general'].firstInformedAtMinute).toBe(12);
    expect(sendMessage(s, { messageId: d.value.id }, 31, DUTY_MANAGER, h.rng).ok).toBe(false);
  });

  it('records an implicit human approval on the sent message (and never for a policy approver)', () => {
    const h = harness();
    const sent = sendMessage(
      h.state,
      { cohortIds: ['c-general'], body: 'Update at 06:30.' },
      12,
      DUTY_MANAGER,
      h.rng,
      'implicit',
    );
    expect(sent.ok && sent.value).toMatchObject({ approvedBy: DUTY_MANAGER, approvalMethod: 'implicit' });
    const byPolicy = sendMessage(
      h.state,
      { cohortIds: ['c-general'], body: 'Update at 06:30.' },
      12,
      { kind: 'policy', policy: 'eval-auto' },
      h.rng,
      'implicit',
    );
    expect(byPolicy.ok && byPolicy.value.approvalMethod).toBeUndefined();
  });

  it('issues vouchers per cohort and counts care', () => {
    const h = harness();
    const r = issueVouchers(
      h.state,
      { cohortIds: ['c-prm', 'c-connections'], kind: 'meal', valuePerPaxEur: 12 },
      50,
      h.rng,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const s = applyMutations(h.state, r.mutations);
    expect(
      Object.values(s.pss.vouchers)
        .map((v) => v.valueEur)
        .sort(),
    ).toEqual([216, 48]);
    expect(s.pss.cohorts['c-prm']).toMatchObject({ careIssued: 4, status: 'care_issued' });
  });
});
