/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ToolDefinition } from '@ica/schema';
import { requestResource, requestStand } from '../systems/airport/index';
import { applyMutations } from '../systems/util';
import { REQUEST_ID_KEY, S, byRequestId, err, obj, ok, replayed, tagRequest } from './_shared';

export const request_tow: ToolDefinition<{ tail: string; requestId: string; toStandId?: string }> = {
  name: 'request_tow',
  description:
    "Request a tug and tow team for an aircraft (takes a tug from the handler's pool). Optionally also request the destination stand. Returns the tug ETA in sim minutes; fails if no tug is free.",
  inputSchema: obj({ tail: S.tail, toStandId: S.id, requestId: S.requestId }, ['tail', 'requestId']),
  tier: 'execute',
  system: 'airport',
  roles: ['ground'],
  mutates: true,
  idempotencyKey: REQUEST_ID_KEY,
  refs: [
    { path: '/tail', kind: 'tail' },
    { path: '/toStandId', kind: 'stand' },
  ],
  async handler(input, ctx) {
    const [priorTow] = byRequestId(ctx.state.airport.resourceRequests, input.requestId);
    if (priorTow) {
      const [priorStand] = byRequestId(ctx.state.airport.standRequests, input.requestId);
      return replayed({ tow: priorTow, ...(priorStand ? { standRequest: priorStand } : {}) });
    }
    const ac = ctx.state.mne.aircraft[input.tail];
    if (!ac) return err(`unknown tail ${input.tail}`);
    const tow = requestResource(
      ctx.state,
      { kind: 'tow', station: ac.station, tail: input.tail },
      ctx.simMinute,
      ctx.scenario.world.handler.ackMinutes,
      ctx.rng,
    );
    if (!tow.ok) return err(tow.error);
    const mutations = [...tow.mutations];
    let standRequest;
    if (input.toStandId) {
      const sr = requestStand(
        applyMutations(ctx.state, mutations),
        { standId: input.toStandId, tail: input.tail },
        ctx.simMinute,
        ctx.rng,
      );
      if (!sr.ok) return err(sr.error);
      mutations.push(...sr.mutations);
      standRequest = sr.value;
    }
    const tagged = tagRequest(
      tagRequest(mutations, 'airport', 'resourceRequests', input.requestId),
      'airport',
      'standRequests',
      input.requestId,
    );
    return ok(
      {
        tow: { ...tow.value, requestId: input.requestId },
        ...(standRequest ? { standRequest: { ...standRequest, requestId: input.requestId } } : {}),
      },
      tagged,
    );
  },
};
