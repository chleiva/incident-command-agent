/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ToolDefinition, Voucher } from '@ica/schema';
import { issueVouchers } from '../systems/pss/index';
import { S, arrayOf, fromResult, obj, requireApproval } from './_shared';

export const issue_care_vouchers: ToolDefinition<{
  cohortIds: string[];
  kind: Voucher['kind'];
  valuePerPaxEur: number;
}> = {
  name: 'issue_care_vouchers',
  description:
    'Propose issuing care (EU261 Art. 9 / UK261): meal or refreshment vouchers, hotel or transport, per passenger in the chosen cohorts. A human approves. Returns the vouchers and total value.',
  inputSchema: obj(
    {
      cohortIds: arrayOf(S.id, 12),
      kind: { type: 'string', enum: ['meal', 'refreshment', 'hotel', 'transport'] },
      valuePerPaxEur: { type: 'number', minimum: 1, maximum: 300 },
    },
    ['cohortIds', 'kind', 'valuePerPaxEur'],
  ),
  tier: 'propose',
  system: 'pss',
  roles: ['passenger'],
  mutates: true,
  approvalScope: 'Issuing the listed care vouchers to the cohorts shown.',
  approvalExclusions: [
    'Compensation decisions (passengers keep their rights)',
    'Hotel or rebooking beyond the vouchers listed',
  ],
  defaultUnresolvedChecks: ['Vendors at the station can honour the vouchers'],
  refs: [{ path: '/cohortIds', kind: 'cohort' }],
  async handler(input, ctx) {
    const denied = requireApproval(ctx);
    if (denied) return { ok: false, error: denied };
    return fromResult(issueVouchers(ctx.state, input, ctx.simMinute, ctx.rng), (vs) => ({
      vouchers: vs,
      totalEur: vs.reduce((a, v) => a + v.valueEur, 0),
    }));
  },
};
