/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ToolDefinition } from '@ica/schema';
import { curfewConflict, etaMin, etdMin, tailFlights } from '../systems/occ/index';
import { S, err, obj, ok } from './_shared';

export const get_rotation: ToolDefinition<{ tail?: string }> = {
  name: 'get_rotation',
  description:
    "The day's rotation for a tail (default: the incident aircraft): each flight's STD/ETD, delay (primary and reactionary), status, passengers and any curfew conflict of its current ETD; plus spare aircraft and curfews. Times are ISO and sim minutes.",
  inputSchema: obj({ tail: S.tail }),
  tier: 'execute',
  system: 'occ',
  roles: ['flightops'],
  mutates: false,
  refs: [{ path: '/tail', kind: 'tail' }],
  async handler(input, ctx) {
    const tail = input.tail ?? ctx.scenario.aircraft.tail;
    const flights = tailFlights(ctx.state, tail);
    if (!flights.length && !ctx.state.occ.spares[tail]) return err(`no rotation for ${tail}`);
    return ok({
      tail,
      simMinute: ctx.simMinute,
      aircraftStatus: ctx.state.mne.aircraft[tail]?.status ?? 'unknown',
      flights: flights.map((f) => {
        const etd = etdMin(ctx.state, f);
        const conflict =
          f.status === 'cancelled' || f.status === 'departed' ? undefined : curfewConflict(ctx.state, f, etd);
        return {
          flight: f.flight,
          from: f.from,
          to: f.to,
          std: f.std,
          etd: f.etd ?? f.std,
          etdMinute: Math.round(etd),
          etaMinute: Math.round(etaMin(ctx.state, f)),
          status: f.status,
          delayMin: f.delayMin,
          reactionaryDelayMin: f.reactionaryDelayMin,
          pax: f.pax,
          ...(conflict ? { curfewConflict: conflict } : {}),
        };
      }),
      spares: Object.values(ctx.state.occ.spares),
      curfews: Object.values(ctx.state.occ.curfews),
    });
  },
};
