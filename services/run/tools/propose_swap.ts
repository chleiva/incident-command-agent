/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ToolDefinition } from '@ica/schema';
import { requestSwap } from '../systems/occ/index';
import { S, approverOf, arrayOf, fromResult, obj, requireApproval } from './_shared';

export const propose_swap: ToolDefinition<{ fromTail: string; toTail: string; flights: string[] }> = {
  name: 'propose_swap',
  description:
    'Propose an aircraft swap: the spare `toTail` takes over `flights` from `fromTail`. A duty manager decides; approving SENDS A SWAP REQUEST to OCC (status requested). OCC confirms and executes it a few minutes later (the flights are then re-tailed and re-timed, with reactionary delay propagated, and the spare is assigned), or refuses it if it is no longer feasible. Check feasibility with find_spare_aircraft first.',
  inputSchema: obj({ fromTail: S.tail, toTail: S.tail, flights: arrayOf(S.flight, 8) }, [
    'fromTail',
    'toTail',
    'flights',
  ]),
  tier: 'propose',
  system: 'occ',
  roles: ['flightops'],
  mutates: true,
  approvalScope: 'Sending this swap request to Operations Control (OCC). OCC confirms and executes the swap.',
  approvalExclusions: [
    'Executing the swap: OCC confirms and executes it',
    'Crew changes, passenger messages or rebooking',
    'Any release of either aircraft (certifying staff)',
  ],
  defaultUnresolvedChecks: [
    'Spare aircraft serviceability confirmed by maintenance control',
    'Crew for the swapped flights confirmed by crew control',
  ],
  refs: [
    { path: '/fromTail', kind: 'tail' },
    { path: '/toTail', kind: 'tail' },
    { path: '/flights', kind: 'flight' },
  ],
  async handler(input, ctx) {
    const denied = requireApproval(ctx);
    if (denied) return { ok: false, error: denied };
    return fromResult(requestSwap(ctx.state, input, ctx.simMinute, approverOf(ctx), ctx.rng), (s) => ({
      swap: { id: s.id, fromTail: s.fromTail, toTail: s.toTail, flights: s.flights, status: s.status },
      note: `Swap request sent to OCC; OCC confirms and executes it (expected at minute ${s.confirmAtMinute}).`,
      expectedDepartureMinute: s.plan.departureMinute,
      expectedDelayMin: s.plan.delayMin,
      onTime: s.plan.onTime,
    }));
  },
};
