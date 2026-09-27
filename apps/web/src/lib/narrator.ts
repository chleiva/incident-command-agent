/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Story captions (spec §4 "Narrator"): one-line captions generated client-side from templates over events.
 * No LLM. Returns null for events that do not deserve a caption.
 */
import type { Engineer, PassengerMessage, RunEvent, SwapDecision } from '@ica/schema/browser';
import { ROLE_LABEL, humaniseTool } from './format';

export function captionFor(e: RunEvent): string | null {
  switch (e.type) {
    case 'run.started':
      return 'World clock started';
    case 'agent.started':
      return e.payload.role === 'orchestrator'
        ? 'Incident opened — the orchestrator is briefing the specialists'
        : `${ROLE_LABEL[e.payload.role]} agent joins`;
    case 'world.process':
      return e.payload.change;
    case 'world.twist':
      return `Twist — ${e.payload.title}`;
    case 'agent.proposal':
      return `Decision needed — ${e.payload.summary}`;
    case 'approval.decision': {
      if (e.payload.decidedBy.kind === 'policy' && e.payload.decidedBy.policy === 'simulation-auto')
        return 'Auto-approved (simulation) — no one decided within the countdown';
      const who = e.payload.decidedBy.kind === 'human' ? e.payload.decidedBy.roleTitle : 'Policy';
      const verb =
        e.payload.decision === 'approve'
          ? 'approved'
          : e.payload.decision === 'edit'
            ? 'edited and approved'
            : 'rejected';
      return `${who} ${verb} the proposal`;
    }
    case 'guardrail.blocked':
      return `Blocked — ${e.payload.tool ? humaniseTool(e.payload.tool) : 'an action'} is reserved for humans; nothing changed`;
    case 'system.mutation': {
      const p = e.payload;
      if (p.system === 'engineers' && p.entity === 'engineers') {
        const a = p.after as Partial<Engineer> | undefined;
        const b = p.before as Partial<Engineer> | undefined;
        if (a?.status === 'travelling' && b?.status !== 'travelling' && a.etaMinute !== undefined) {
          const eta = Math.max(1, Math.round(a.etaMinute - e.simMinute));
          return `Engineer paged — ETA ${eta} min`;
        }
      }
      if (p.system === 'pss' && p.entity === 'messages') {
        const a = p.after as Partial<PassengerMessage> | undefined;
        const b = p.before as Partial<PassengerMessage> | undefined;
        if (a?.status === 'sent' && b?.status !== 'sent')
          return 'Passengers informed — AI-drafted message, approved by a human';
      }
      if (p.system === 'occ' && p.entity === 'swaps' && p.op === 'create') {
        const s = p.after as Partial<SwapDecision> | undefined;
        return `Aircraft swap: ${s?.fromTail ?? '?'} → ${s?.toTail ?? '?'}`;
      }
      if (p.system === 'record' && p.entity === 'evidencePacks') return 'Evidence pack ready for export';
      return null;
    }
    case 'agent.report':
      return e.payload.role === 'orchestrator' ? `Wrap-up — ${e.payload.report.summary}` : null;
    case 'run.paused':
      return 'World clock paused';
    case 'run.resumed':
      return 'World clock resumed';
    case 'run.completed':
      return e.payload.reason === 'stopped' ? 'Run stopped by the presenter' : 'Run complete';
    case 'run.failed':
      return 'Run failed — see the agent activity';
    default:
      return null;
  }
}

/** The most recent caption at or before the end of `events` (looks back a bounded window). */
export function latestCaption(
  events: readonly RunEvent[],
  lookBack = 80,
): { seq: number; text: string } | null {
  for (let i = events.length - 1; i >= Math.max(0, events.length - lookBack); i--) {
    const text = captionFor(events[i]!);
    if (text) return { seq: events[i]!.seq, text };
  }
  return null;
}
