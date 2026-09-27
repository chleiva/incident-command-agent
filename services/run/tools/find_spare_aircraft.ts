/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ToolDefinition } from '@ica/schema';
import { isActive, planSwap, stdMin, tailFlights } from '../systems/occ/index';
import { S, err, obj, ok } from './_shared';

export const find_spare_aircraft: ToolDefinition<{ flight: string }> = {
  name: 'find_spare_aircraft',
  description:
    "Evaluate every spare aircraft for taking over a flight and the rest of its tail's rotation: for each spare, whether a swap is feasible (type, station, availability, curfew), the resulting departure minute and delay, or why not. Use before propose_swap.",
  inputSchema: obj({ flight: S.flight }, ['flight']),
  tier: 'execute',
  system: 'occ',
  roles: ['flightops'],
  mutates: false,
  refs: [{ path: '/flight', kind: 'flight' }],
  async handler({ flight }, ctx) {
    const f = ctx.state.occ.flights[flight];
    if (!f) return err(`unknown flight ${flight}`);
    const block = tailFlights(ctx.state, f.tail)
      .filter((x) => isActive(x) && stdMin(ctx.state, x) >= stdMin(ctx.state, f))
      .map((x) => x.flight);
    const candidates = Object.values(ctx.state.occ.spares).map((s) => {
      const plan = planSwap(ctx.state, { fromTail: f.tail, toTail: s.tail, flights: block }, ctx.simMinute);
      return plan.ok
        ? {
            tail: s.tail,
            type: s.type,
            station: s.station,
            feasible: true,
            onTime: plan.value.onTime,
            departureMinute: plan.value.departureMinute,
            delayMin: plan.value.delayMin,
          }
        : { tail: s.tail, type: s.type, station: s.station, feasible: false, reason: plan.error };
    });
    return ok({
      fromTail: f.tail,
      flights: block,
      candidates,
      feasibleCount: candidates.filter((c) => c.feasible).length,
    });
  },
};
