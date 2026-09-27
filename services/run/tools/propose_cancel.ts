/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ToolDefinition } from '@ica/schema';
import { executeCancel } from '../systems/occ/index';
import { S, approverOf, fromResult, obj, requireApproval } from './_shared';

export const propose_cancel: ToolDefinition<{ flight: string }> = {
  name: 'propose_cancel',
  description:
    'Propose cancelling a flight. A duty manager decides; once approved the flight and the downstream legs the rotation can no longer reach are cancelled (swap later legs onto a spare first if you want to keep them). Cancellation triggers passenger rights (re-routing, care, possibly compensation): coordinate with passenger services.',
  inputSchema: obj({ flight: S.flight }, ['flight']),
  tier: 'propose',
  system: 'occ',
  roles: ['flightops'],
  mutates: true,
  approvalScope: 'Cancelling the flight shown (and the downstream legs the system lists) in OCC.',
  approvalExclusions: [
    'Rebooking, care or compensation for its passengers (proposed separately)',
    'Any swap or crew change',
  ],
  defaultUnresolvedChecks: [
    'Rebooking capacity for every affected cohort',
    'Crew and aircraft positioning for the next day',
  ],
  refs: [{ path: '/flight', kind: 'flight' }],
  async handler(input, ctx) {
    const denied = requireApproval(ctx);
    if (denied) return { ok: false, error: denied };
    return fromResult(executeCancel(ctx.state, input.flight, approverOf(ctx), ctx.rng), (r) => ({
      cancellation: r.decision,
      alsoCancelled: r.alsoCancelled,
    }));
  },
};
