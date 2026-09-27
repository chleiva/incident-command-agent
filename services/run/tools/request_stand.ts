/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import type { StandRequest, ToolDefinition } from '@ica/schema';
import { requestStand } from '../systems/airport/index';
import { REQUEST_ID_KEY, S, byRequestId, fromResult, obj, replayed, tagRequest } from './_shared';

export const request_stand: ToolDefinition<{ tail: string; standId: string; requestId: string }> = {
  name: 'request_stand',
  description:
    'Ask airport operations for a stand for an aircraft (e.g. a remote stand to free a contact stand). Confirmation arrives after a few minutes, or the request is rejected if the stand is still occupied then. Returns the request id and the expected answer time.',
  inputSchema: obj({ tail: S.tail, standId: S.id, requestId: S.requestId }, ['tail', 'standId', 'requestId']),
  tier: 'execute',
  system: 'airport',
  roles: ['ground'],
  mutates: true,
  idempotencyKey: REQUEST_ID_KEY,
  refs: [
    { path: '/tail', kind: 'tail' },
    { path: '/standId', kind: 'stand' },
  ],
  async handler(input, ctx) {
    const shape = (r: StandRequest) => ({
      standRequest: r,
      note: `answer expected at minute ${r.confirmAtMinute}`,
    });
    const [prior] = byRequestId(ctx.state.airport.standRequests, input.requestId);
    if (prior) return replayed(shape(prior));
    const r = requestStand(ctx.state, input, ctx.simMinute, ctx.rng);
    return fromResult(
      r.ok ? { ...r, mutations: tagRequest(r.mutations, 'airport', 'standRequests', input.requestId) } : r,
      (x) => shape({ ...x, requestId: input.requestId }),
    );
  },
};
