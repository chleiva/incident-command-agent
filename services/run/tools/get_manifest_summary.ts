/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ToolDefinition } from '@ica/schema';
import { S, obj, ok } from './_shared';

export const get_manifest_summary: ToolDefinition<{ flight?: string }> = {
  name: 'get_manifest_summary',
  description:
    'Passenger picture by cohort (connections with onward deadlines, PRM, families, unaccompanied minors, premium, general): counts, status (uninformed/informed/care issued/rebooked), when first informed, care issued; plus rebooking options with free seats and messages so far. No personal data.',
  inputSchema: obj({ flight: S.flight }),
  tier: 'execute',
  system: 'pss',
  roles: ['passenger'],
  mutates: false,
  refs: [{ path: '/flight', kind: 'flight' }],
  async handler(input, ctx) {
    const p = ctx.state.pss;
    const cohorts = Object.values(p.cohorts).filter((c) => !input.flight || c.flight === input.flight);
    return ok({
      simMinute: ctx.simMinute,
      totalPassengers: cohorts.reduce((a, c) => a + c.count, 0),
      uninformed: cohorts.filter((c) => c.status === 'uninformed').reduce((a, c) => a + c.count, 0),
      cohorts,
      rebookingOptions: Object.values(p.rebookingOptions),
      messages: Object.values(p.messages).map((m) => ({
        id: m.id,
        status: m.status,
        cohortIds: m.cohortIds,
        sentAtMinute: m.sentAtMinute,
      })),
      vouchersIssued: Object.values(p.vouchers).length,
    });
  },
};
