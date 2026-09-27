/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ToolDefinition } from '@ica/schema';
import { assignStandby } from '../systems/crew/index';
import { REQUEST_ID_KEY, S, byRequestId, fromResult, obj, replayed, requireApproval } from './_shared';

export const assign_standby_crew: ToolDefinition<{
  standbyId: string;
  replacesCrewId: string;
  flight: string;
  requestId: string;
}> = {
  name: 'assign_standby_crew',
  description:
    'Propose calling out a standby crew member to replace another from a flight onwards (same rank, enough FDP). Crew control decides; once approved the standby is assigned and the replaced member stood down. Check candidates with find_standby_crew first.',
  inputSchema: obj({ standbyId: S.id, replacesCrewId: S.id, flight: S.flight, requestId: S.requestId }, [
    'standbyId',
    'replacesCrewId',
    'flight',
    'requestId',
  ]),
  tier: 'propose',
  system: 'crew',
  roles: ['flightops'],
  mutates: true,
  idempotencyKey: REQUEST_ID_KEY,
  approvalScope: 'Calling out this standby crew member for the flight shown, replacing the named member.',
  approvalExclusions: [
    'Any extension of a flight duty period (commander only)',
    'Any other crew change or a swap or cancellation',
  ],
  defaultUnresolvedChecks: ['The standby member has been reached and confirmed the call-out'],
  refs: [
    { path: '/standbyId', kind: 'crew' },
    { path: '/replacesCrewId', kind: 'crew' },
    { path: '/flight', kind: 'flight' },
  ],
  async handler(input, ctx) {
    const denied = requireApproval(ctx);
    if (denied) return { ok: false, error: denied };
    const [prior] = byRequestId(ctx.state.crew.crew, input.requestId, 'assignmentRequestId');
    if (prior)
      return replayed({
        assigned: {
          id: prior.id,
          name: prior.name,
          flight: prior.assignedFlight,
          fdpMarginMin: prior.fdpRemainingMin,
        },
      });
    const r = assignStandby(ctx.state, input, ctx.simMinute);
    const tagged = r.ok
      ? {
          ...r,
          mutations: r.mutations.map((m) =>
            m.system === 'crew' && m.id === input.standbyId && m.after
              ? { ...m, after: { ...m.after, assignmentRequestId: input.requestId } }
              : m,
          ),
        }
      : r;
    return fromResult(tagged, (r) => ({
      assigned: {
        id: r.assigned.id,
        name: r.assigned.name,
        flight: r.assigned.assignedFlight,
        fdpMarginMin: r.assigned.fdpRemainingMin,
      },
      replaced: { id: r.replaced.id, status: r.replaced.status },
      requiredFdpMin: r.requiredFdpMin,
    }));
  },
};
