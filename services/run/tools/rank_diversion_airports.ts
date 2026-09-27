/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import { OPTIONS_ONLY_NOTE, suitableAirports, type NetworkAircraftType } from '@ica/network';
import type { ToolDefinition } from '@ica/schema';
import { airborneNow } from '../systems/occ/index';
import { originMs } from '../systems/util';
import { S, err, obj, ok } from './_shared';

/**
 * Task 07: rank candidate airports near an airborne aircraft by distance and ground-side suitability. OPTIONS ONLY:
 * the result is for the commander's consideration; choosing the airport is forbidden to software
 * (`select_diversion_airport`).
 */
export const rank_diversion_airports: ToolDefinition<{ flight?: string; maxDistanceKm?: number }> = {
  name: 'rank_diversion_airports',
  description:
    "Rank airports near an aircraft in the air by distance and ground-side suitability (runway, fire cover, handling contract, engineering cover, hotels, curfew). OPTIONS ONLY, for the commander's consideration and to prepare the ground: the commander decides whether and where to divert.",
  inputSchema: obj({
    flight: S.flight,
    maxDistanceKm: { type: 'integer', minimum: 100, maximum: 1500 },
  }),
  tier: 'execute',
  system: 'occ',
  roles: ['flightops'],
  mutates: false,
  refs: [{ path: '/flight', kind: 'flight' }],
  async handler(input, ctx) {
    const a = input.flight
      ? ctx.state.occ.airborne?.[input.flight]
      : Object.values(ctx.state.occ.airborne ?? {})[0];
    if (!a) return err('no aircraft in the air to rank airports for');
    const now = airborneNow(a, ctx.simMinute);
    const type = (ctx.state.mne.aircraft[a.tail]?.type ?? 'A320') as NetworkAircraftType;
    const origin = originMs(ctx.state);
    const atMs = origin === undefined ? undefined : origin + ctx.simMinute * 60_000;
    const ranked = suitableAirports(
      { lat: now.lat, lon: now.lon },
      ['A319', 'A320', 'A321'].includes(type) ? type : 'A320',
      {
        maxDistanceKm: input.maxDistanceKm ?? 700,
        limit: 5,
        ...(atMs !== undefined ? { atMs } : {}),
      },
    );
    return ok({
      flight: a.flight,
      from: { lat: now.lat, lon: now.lon },
      options: ranked.map((r, i) => ({
        rank: i + 1,
        iata: r.iata,
        name: r.city,
        distanceKm: r.distanceKm,
        etaMin: r.etaMin,
        suitable: r.suitable,
        runwayM: r.capability.runwayM,
        rffsCategory: r.capability.rffsCat,
        handlingContract: r.capability.handlingContract,
        engineering: r.capability.engineering,
        hotelRooms: r.capability.hotelRooms,
        reasons: r.reasons,
      })),
      forTheCommander: true,
      note: OPTIONS_ONLY_NOTE,
      dataNote: 'Airport capability data is illustrative (fictional where invented).',
    });
  },
};
