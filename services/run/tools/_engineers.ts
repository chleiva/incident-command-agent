/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Engineer status view shared by the reads that answer "who is coming, and when" (`get_aircraft_status` for
 * maintenance, `get_stand_status` for ground). The responding engineer is chosen by `respondingEngineer`
 * (@ica/schema), the same helper the cockpit's ground/airport ETA path uses, so agents and the screen name the same
 * person.
 */
import { respondingEngineer, type Engineer, type ToolContext } from '@ica/schema';

export function engineerRow(e: Engineer, simMinute: number) {
  return {
    id: e.id,
    name: e.name,
    licence: e.licence,
    skills: e.skills,
    status: e.status,
    location: e.location,
    ...(e.destination ? { destination: e.destination } : {}),
    ...(e.travelMode ? { travel: e.travelMode } : {}),
    ...(e.etaMinute !== undefined ? { etaMinute: e.etaMinute } : {}),
    ...(e.etaMinute !== undefined && (e.status === 'paged' || e.status === 'travelling')
      ? { minutesToArrival: Math.max(0, Math.round(e.etaMinute - simMinute)) }
      : {}),
    ...(e.pagedAtMinute !== undefined ? { pagedAtMinute: e.pagedAtMinute } : {}),
    ...(e.workOrderId ? { workOrderId: e.workOrderId } : {}),
    ...(e.pageReason ? { pageReason: e.pageReason } : {}),
    ...(e.availableFromMinute !== undefined ? { availableFromMinute: e.availableFromMinute } : {}),
    ...(e.pendingEtaDelayMin ? { pendingEtaDelayMin: e.pendingEtaDelayMin } : {}),
  };
}

/** `responding` (THE engineer coming to the incident, or null) + the roster. */
export function engineerStatus(ctx: Pick<ToolContext, 'state' | 'scenario' | 'simMinute'>, tail?: string) {
  const responding = respondingEngineer(ctx.state, { tail: tail ?? ctx.scenario?.aircraft.tail });
  return {
    responding: responding ? engineerRow(responding, ctx.simMinute) : null,
    ...(responding ? {} : { note: 'No engineer has been paged yet.' }),
    roster: Object.values(ctx.state.engineers.engineers).map((e) => engineerRow(e, ctx.simMinute)),
  };
}
