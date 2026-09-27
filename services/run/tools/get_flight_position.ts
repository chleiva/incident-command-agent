/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ToolDefinition } from '@ica/schema';
import { airborneNow } from '../systems/occ/index';
import { S, err, obj, ok } from './_shared';

export const COMMANDER_NOTE =
  'The commander flies the aircraft and decides its conduct (turn back, divert, which airport, overweight landing). The ground team prepares and supports; it never instructs the flight deck.';

/** Task 07: read the flight-following position of an aircraft in the air. */
export const get_flight_position: ToolDefinition<{ flight?: string }> = {
  name: 'get_flight_position',
  description:
    "Flight-following view of an aircraft in the air (simulated feed): phase, squawk (normal / PAN / MAYDAY), position, altitude, heading, current destination, ETA and a notional fuel endurance, plus the commander's decision once relayed. Read-only.",
  inputSchema: obj({ flight: S.flight }),
  tier: 'execute',
  system: 'occ',
  roles: ['flightops', 'ground', 'maintenance'],
  mutates: false,
  refs: [{ path: '/flight', kind: 'flight' }],
  async handler(input, ctx) {
    const all = Object.values(ctx.state.occ.airborne ?? {});
    const a = input.flight ? ctx.state.occ.airborne?.[input.flight] : all[0];
    if (!a)
      return err(
        input.flight ? `${input.flight} is not in the air` : 'no aircraft in the air in this incident',
      );
    const now = airborneNow(a, ctx.simMinute);
    const log = Object.values(ctx.state.occ.commanderLog ?? {}).filter((l) => l.flight === a.flight);
    return ok({ ...now, simMinute: ctx.simMinute, commanderLog: log, note: COMMANDER_NOTE });
  },
};
