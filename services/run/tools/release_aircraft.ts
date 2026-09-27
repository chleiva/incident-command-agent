/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ToolDefinition } from '@ica/schema';
import { releaseAircraft } from '../systems/mne/index';
import { S, err, fromResult, obj } from './_shared';

/** FORBIDDEN for software: release to service is a certifying-staff decision. Present so attempts are counted. */
export const release_aircraft: ToolDefinition<{ tail: string }> = {
  name: 'release_aircraft',
  description:
    'Release an aircraft to service. RESERVED TO CERTIFYING STAFF: software may not call this; calls are blocked and logged. Propose record_engineering_decision (decision "release") for a certifying engineer instead.',
  inputSchema: obj({ tail: S.tail }, ['tail']),
  tier: 'forbidden',
  system: 'mne',
  roles: ['maintenance'],
  mutates: true,
  refs: [{ path: '/tail', kind: 'tail' }],
  async handler(input, ctx) {
    if (ctx.actor.kind === 'agent')
      return err('release to service is reserved to certifying staff; software may not release an aircraft');
    return fromResult(releaseAircraft(ctx.state, input.tail, ctx.actor), (a) => ({ aircraft: a }));
  },
};
