/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Approval invalidation (task 06 §1.7). Proposals record the facts they depend on (`assumptions`, derived here by
 * the runtime from mock state); when a twist or any mutation changes one of them after the proposal was approved,
 * the world engine emits `approval.invalidated` and the runtime asks the owning agent to re-gather evidence and
 * issue a revised proposal (`supersedesApprovalId`). Pure functions only.
 */
import type { AgentRole, Assumption, RunEvent, SystemState } from '@ica/schema';

/** `system/entity/id#field` → its parts. */
export function parseSource(
  source: string,
): { system: string; entity: string; id: string; field: string } | null {
  const m = /^([a-z]+)\/([A-Za-z]+)\/([^#]+)#([A-Za-z]+)$/.exec(source);
  return m ? { system: m[1]!, entity: m[2]!, id: m[3]!, field: m[4]! } : null;
}

/** Current value of a state source (`null` when the entity or field is missing). */
export function readSource(state: SystemState, source: string): Assumption['value'] {
  const p = parseSource(source);
  if (!p) return null;
  const loose = state as unknown as Record<string, Record<string, Record<string, Record<string, unknown>>>>;
  const v = loose[p.system]?.[p.entity]?.[p.id]?.[p.field];
  return typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean' ? v : null;
}

/**
 * The facts a proposal depends on, read from mock state at proposal time:
 * - `engineerEtaMinute`: the ETA of every engineer on the way (paged or travelling);
 * - `spareAvailableFromMinute` for a swap: when the spare aircraft is available.
 */
export function deriveAssumptions(
  state: SystemState,
  tool: string,
  args: Record<string, unknown>,
): Assumption[] {
  const out: Assumption[] = [];
  const onTheWay = Object.values(state.engineers?.engineers ?? {}).filter(
    (e) => (e.status === 'paged' || e.status === 'travelling') && typeof e.etaMinute === 'number',
  );
  for (const e of onTheWay) {
    out.push({
      key: onTheWay.length > 1 ? `engineerEtaMinute:${e.id}` : 'engineerEtaMinute',
      value: e.etaMinute!,
      source: `engineers/engineers/${e.id}#etaMinute`,
    });
  }
  if (tool === 'propose_swap' && typeof args.toTail === 'string') {
    const spare = state.occ?.spares?.[args.toTail];
    if (spare)
      out.push({
        key: 'spareAvailableFromMinute',
        value: spare.availableFromMinute,
        source: `occ/spares/${spare.tail}#availableFromMinute`,
      });
  }
  return out;
}

export interface Invalidation {
  approvalId: string;
  tool: string;
  role?: AgentRole;
  agentRunId?: string;
  affected: { key: string; was: unknown; now: unknown; source: string }[];
  /** Latest event that changed one of the sources. */
  causedBySeq?: number;
}

/**
 * Approved (or edited) proposals whose assumptions no longer hold. `done` holds approval ids already invalidated
 * (each approval is invalidated at most once; its revision carries fresh assumptions).
 */
export function findInvalidations(
  events: readonly RunEvent[],
  state: SystemState,
  done: ReadonlySet<string>,
): Invalidation[] {
  const approved = new Set<string>();
  for (const e of events) {
    if (e.type === 'approval.decision' && e.payload.decision !== 'reject') approved.add(e.payload.approvalId);
    if (e.type === 'approval.invalidated') approved.delete(e.payload.approvalId);
  }
  const already = new Set(done);
  for (const e of events) if (e.type === 'approval.invalidated') already.add(e.payload.approvalId);
  const out: Invalidation[] = [];
  for (const e of events) {
    if (e.type !== 'agent.proposal') continue;
    const p = e.payload;
    if (!p.assumptions?.length || !approved.has(p.approvalId) || already.has(p.approvalId)) continue;
    const affected = p.assumptions
      .map((a) => ({ key: a.key, was: a.value, now: readSource(state, a.source), source: a.source }))
      .filter((a) => JSON.stringify(a.was) !== JSON.stringify(a.now));
    if (!affected.length) continue;
    let causedBySeq: number | undefined;
    for (const a of affected) {
      const src = parseSource(a.source);
      if (!src) continue;
      for (let i = events.length - 1; i >= 0; i--) {
        const m = events[i]!;
        if (
          m.type === 'system.mutation' &&
          m.payload.system === src.system &&
          m.payload.entity === src.entity &&
          m.payload.id === src.id
        ) {
          causedBySeq = Math.max(causedBySeq ?? 0, m.seq);
          break;
        }
      }
    }
    out.push({
      approvalId: p.approvalId,
      tool: p.tool,
      ...(e.actor.kind === 'agent' ? { role: e.actor.role } : {}),
      ...(e.agentRunId ? { agentRunId: e.agentRunId } : {}),
      affected,
      ...(causedBySeq ? { causedBySeq } : {}),
    });
  }
  return out;
}

/** The (constant-shaped) brief for the revising agent. Values are runtime numbers and ids, never free text. */
export function revisionBrief(inv: Invalidation): string {
  const changes = inv.affected
    .map((a) => `${a.key}: ${JSON.stringify(a.was)} → ${JSON.stringify(a.now)}`)
    .join('; ');
  return [
    `REVISION REQUIRED. The approved proposal ${inv.approvalId} (${inv.tool}) is no longer valid: facts it relied on changed (${changes}).`,
    '1. Re-gather the current evidence with your read tools first; do not rely on earlier results.',
    '2. Issue ONE revised proposal of the same kind that reflects the new facts (it is linked to the invalidated approval automatically), with its unresolved checks.',
    '3. Then call report, saying what changed and what you revised.',
  ].join('\n');
}
