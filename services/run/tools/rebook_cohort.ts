/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ToolDefinition } from '@ica/schema';
import { rebookCohort } from '../systems/pss/index';
import { S, fromResult, obj, requireApproval } from './_shared';

export const rebook_cohort: ToolDefinition<{ cohortId: string; toFlight: string }> = {
  name: 'rebook_cohort',
  description:
    'Propose rebooking a whole cohort onto a rebooking option on the same route (only if it has enough free seats). A human approves; seats are then taken. Prioritise connections close to their onward deadline and PRM passengers.',
  inputSchema: obj({ cohortId: S.id, toFlight: S.flight }, ['cohortId', 'toFlight']),
  tier: 'propose',
  system: 'pss',
  roles: ['passenger'],
  mutates: true,
  approvalScope: 'Rebooking the cohort shown onto the flight shown.',
  approvalExclusions: [
    'Refunds or compensation decisions (passengers decide for themselves)',
    'Cancelling the original flight',
  ],
  defaultUnresolvedChecks: ['Passengers have been offered the choice of refund, re-routing or waiting'],
  refs: [
    { path: '/cohortId', kind: 'cohort' },
    { path: '/toFlight', kind: 'flight' },
  ],
  async handler(input, ctx) {
    const denied = requireApproval(ctx);
    if (denied) return { ok: false, error: denied };
    return fromResult(rebookCohort(ctx.state, input.cohortId, input.toFlight), (c) => ({ cohort: c }));
  },
};
