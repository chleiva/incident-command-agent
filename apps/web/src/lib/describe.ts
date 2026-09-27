/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** One-line, human-readable description of any event (jump lists, markers, the why drawer). */
import type { RunEvent } from '@ica/schema/browser';
import { ROLE_LABEL, actorLabel, humaniseTool } from './format';
import { captionFor } from './narrator';

export function describeEvent(e: RunEvent): string {
  switch (e.type) {
    case 'agent.tool_call':
      return `${humaniseTool(e.payload.tool)} (${e.actor.kind === 'agent' ? ROLE_LABEL[e.actor.role] : 'agent'})`;
    case 'agent.tool_result':
      return `${humaniseTool(e.payload.tool)} → ${e.payload.ok ? 'ok' : 'failed'}`;
    case 'agent.thought':
      return e.payload.summary;
    case 'system.mutation': {
      const p = e.payload;
      return (
        captionFor(e) ??
        `${p.system}.${p.entity} ${p.id} ${p.op === 'create' ? 'created' : p.op === 'update' ? 'updated' : 'deleted'}`
      );
    }
    case 'kpi.update':
      return 'KPIs recomputed';
    case 'world.tick':
      return `Minute ${e.payload.simMinute}`;
    case 'approval.decision':
      return `${actorLabel(e.payload.decidedBy)}: ${e.payload.decision}`;
    case 'baseline.action':
      return `${e.payload.actor}: ${humaniseTool(e.payload.tool)}`;
    default:
      return captionFor(e) ?? e.type;
  }
}
