/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import type { CrewMember, ToolContext, ToolDefinition } from '@ica/schema';
import { computeFdp, pairing } from '../systems/crew/index';
import { S, err, obj, ok } from './_shared';

function fdpRow(m: CrewMember, ctx: ToolContext) {
  const f = computeFdp(ctx.state, m, ctx.simMinute);
  return {
    id: m.id,
    name: m.name,
    rank: m.rank,
    status: m.status,
    station: m.station,
    reportTime: m.reportTime,
    maxFdpMin: m.maxFdpMin,
    fdpUsedMin: f.usedMin,
    remainingPlannedMin: f.remainingPlannedMin,
    fdpMarginMin: f.remainingMin,
    sectors: pairing(ctx.state, m).map((x) => x.flight),
    ...(f.remainingMin < 0 ? { warning: 'planned duty exceeds maximum FDP' } : {}),
  };
}

export const get_crew_fdp: ToolDefinition<{ crewId?: string; flight?: string }> = {
  name: 'get_crew_fdp',
  description:
    "Flight duty period status now. Call it ONCE WITHOUT crewId to get every operating and standby crew member in one result (report time, FDP used, remaining planned duty to the last sector including current delays, margin against the maximum, sectors still to fly), with the members at risk listed first; add `flight` to narrow to one flight's crew. Pass crewId only to re-check one person after a change. A negative margin means the plan is illegal without a change.",
  inputSchema: obj({ crewId: S.id, flight: S.flight }),
  tier: 'execute',
  system: 'crew',
  roles: ['flightops'],
  mutates: false,
  refs: [
    { path: '/crewId', kind: 'crew' },
    { path: '/flight', kind: 'flight' },
  ],
  async handler(input, ctx) {
    if (input.crewId) {
      const m = ctx.state.crew.crew[input.crewId];
      if (!m) return err(`unknown crew member ${input.crewId}`);
      return ok({ simMinute: ctx.simMinute, crew: [fdpRow(m, ctx)] });
    }
    const all = Object.values(ctx.state.crew.crew).filter((m) => m.status !== 'off');
    const rows = all
      .map((m) => fdpRow(m, ctx))
      .filter((r) => !input.flight || r.sectors.includes(input.flight) || r.status === 'standby');
    const onDuty = rows.filter((r) => r.status !== 'standby');
    const atRisk = onDuty.filter((r) => r.fdpMarginMin < 0).sort((a, b) => a.fdpMarginMin - b.fdpMarginMin);
    const operating = [...atRisk, ...onDuty.filter((r) => r.fdpMarginMin >= 0)];
    const standby = rows.filter((r) => r.status === 'standby');
    return ok({
      simMinute: ctx.simMinute,
      ...(input.flight ? { flight: input.flight } : {}),
      atRisk: atRisk.map((r) => ({
        id: r.id,
        rank: r.rank,
        fdpMarginMin: r.fdpMarginMin,
        sectors: r.sectors,
      })),
      // `crew` keeps every row (operating, then standby) for callers that read one list.
      crew: [...operating, ...standby],
      standby: standby.map((r) => ({
        id: r.id,
        name: r.name,
        rank: r.rank,
        station: r.station,
        maxFdpMin: r.maxFdpMin,
      })),
      note: 'Complete crew picture for this minute: no need to call get_crew_fdp per crew member.',
    });
  },
};
