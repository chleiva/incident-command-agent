/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ToolDefinition } from '@ica/schema';
import { requestFdpExtension } from '../systems/crew/index';
import { S, err, obj } from './_shared';

/** FORBIDDEN for software (ORO.FTL.205: commander's discretion is a human decision). Present so attempts are counted. */
export const extend_crew_fdp: ToolDefinition<{ crewId: string; minutes: number }> = {
  name: 'extend_crew_fdp',
  description:
    "Extend a crew member's flight duty period. RESERVED TO THE COMMANDER (discretion) — software may not call this; calls are blocked and logged. Use a standby crew, re-plan, or let the record agent draft a discretion report for the commander.",
  inputSchema: obj({ crewId: S.id, minutes: { type: 'integer', minimum: 1, maximum: 180 } }, [
    'crewId',
    'minutes',
  ]),
  tier: 'forbidden',
  system: 'crew',
  roles: ['flightops'],
  mutates: true,
  refs: [{ path: '/crewId', kind: 'crew' }],
  async handler(input, ctx) {
    const r = requestFdpExtension(ctx.state, input.crewId, input.minutes);
    return err(r.ok ? 'FDP extension refused' : r.error);
  },
};
