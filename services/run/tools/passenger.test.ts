/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import { DUTY_MANAGER } from '../systems/testing';
import { argsValid, call, fixtureHarness, okData } from './_testing';

describe('passenger tools', () => {
  it('get_manifest_summary summarises cohorts without personal data', async () => {
    const h = await fixtureHarness();
    const m = okData(await call(h, 'get_manifest_summary', { flight: 'ACX101' }));
    expect(m).toMatchObject({ totalPassengers: 162, uninformed: 162 });
    expect(m.rebookingOptions.length).toBeGreaterThan(0);
  });

  it('estimate_eu261_exposure: tier by distance and 3-hour threshold', async () => {
    const h = await fixtureHarness();
    const now = okData(await call(h, 'estimate_eu261_exposure', {}));
    expect(now.totalEur).toBe(0);
    const late = okData(
      await call(h, 'estimate_eu261_exposure', { cohortIds: ['c-general'], extraDelayMin: 200 }),
    );
    expect(late.lines[0]).toMatchObject({ tierEur: 250, compensationEligible: true, exposureEur: 35000 });
    expect((await call(h, 'estimate_eu261_exposure', { cohortIds: ['nope'] })).ok).toBe(false);
  });

  it('search_passenger_rights cites Regulation 261/2004 (EU) or the CAA (UK)', async () => {
    const h = await fixtureHarness();
    const out = await call(h, 'search_passenger_rights', {
      query: 'right to care meals refreshments',
      jurisdiction: 'EU',
    });
    expect(out.ok && out.citations![0].sourceId).toBe('EU Reg 261/2004 Art 9');
  });

  it('draft → send (after approval) informs cohorts and records sentAtMinute', async () => {
    const h = await fixtureHarness();
    const body =
      'ACX101 to Dublin is delayed while engineers check a door sensor. Please stay near gate 22; next update by 06:30.';
    const d = okData(
      await call(h, 'draft_passenger_message', { cohortIds: ['c-general', 'c-prm'], channel: 'sms', body }),
    );
    expect(d).toMatchObject({ status: 'draft', aiDrafted: true });
    expect((await call(h, 'send_passenger_message', { messageId: d.messageId })).ok).toBe(false);
    h.simMinute = 9;
    const s = okData(
      await call(h, 'send_passenger_message', { messageId: d.messageId }, { approvedBy: DUTY_MANAGER }),
    );
    expect(s).toMatchObject({ status: 'sent', sentAtMinute: 9 });
    expect(h.state.pss.cohorts['c-prm']).toMatchObject({ status: 'informed', firstInformedAtMinute: 9 });
    expect(argsValid('draft_passenger_message', { cohortIds: ['c-prm'], channel: 'fax', body }).ok).toBe(
      false,
    );
  });

  it('issue_care_vouchers and rebook_cohort are approval-gated and rule-bound', async () => {
    const h = await fixtureHarness();
    expect(
      (await call(h, 'issue_care_vouchers', { cohortIds: ['c-prm'], kind: 'meal', valuePerPaxEur: 15 })).ok,
    ).toBe(false);
    const v = okData(
      await call(
        h,
        'issue_care_vouchers',
        { cohortIds: ['c-prm'], kind: 'meal', valuePerPaxEur: 15 },
        { approvedBy: DUTY_MANAGER },
      ),
    );
    expect(v.totalEur).toBe(60);
    const opt = Object.values(h.state.pss.rebookingOptions)[0];
    const big = await call(
      h,
      'rebook_cohort',
      { cohortId: 'c-general', toFlight: opt.flight },
      { approvedBy: DUTY_MANAGER },
    );
    expect(big).toMatchObject({ ok: false, error: expect.stringMatching(/seats/) });
    const ok = okData(
      await call(
        h,
        'rebook_cohort',
        { cohortId: 'c-prm', toFlight: opt.flight },
        { approvedBy: DUTY_MANAGER },
      ),
    );
    expect(ok.cohort).toMatchObject({ status: 'rebooked', rebookedTo: opt.flight });
  });
});
