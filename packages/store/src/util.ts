/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  SYSTEM_ENTITIES,
  type EventDraft,
  type RunEvent,
  type StateSystemName,
  type SystemMutation,
} from '@ica/schema';

export const clone = <T>(x: T): T => (x === undefined ? x : (JSON.parse(JSON.stringify(x)) as T));

export function toEvent(runId: string, seq: number, d: EventDraft, now: () => string): RunEvent {
  const e = { ...d, runId, seq, wallTime: d.wallTime ?? now() } as RunEvent;
  return clone(e);
}

/** Empty entity maps for the requested systems (all when omitted). */
export function emptyStateFor(
  system?: StateSystemName,
): Record<string, Record<string, Record<string, unknown>>> {
  const out: Record<string, Record<string, Record<string, unknown>>> = {};
  const systems = system ? [system] : (Object.keys(SYSTEM_ENTITIES) as StateSystemName[]);
  for (const s of systems) {
    out[s] = {};
    for (const e of SYSTEM_ENTITIES[s]) out[s][e] = {};
  }
  return out;
}

/**
 * Group mutations with the `system.mutation` draft that describes them, so they travel in the same transaction.
 * Returns one group per draft; mutations without a matching draft join the first group.
 */
export function groupMutations(
  drafts: EventDraft[],
  mutations: SystemMutation[],
): { draft: EventDraft | null; mutations: SystemMutation[] }[] {
  const groups = drafts.map((d) => ({ draft: d as EventDraft | null, mutations: [] as SystemMutation[] }));
  const leftovers: SystemMutation[] = [];
  const used = new Set<number>();
  for (const m of mutations) {
    const idx = drafts.findIndex(
      (d, i) =>
        !used.has(i) &&
        d.type === 'system.mutation' &&
        d.payload.system === m.system &&
        d.payload.entity === m.entity &&
        d.payload.id === m.id,
    );
    if (idx >= 0) {
      used.add(idx);
      groups[idx].mutations.push(m);
    } else leftovers.push(m);
  }
  if (leftovers.length) {
    if (groups.length) groups[0].mutations.unshift(...leftovers);
    else groups.push({ draft: null, mutations: leftovers });
  }
  return groups;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The store key of one mock-state row (`SYS#{system}#{entity}#{id}` in DynamoDB). */
export const mutationKey = (m: Pick<SystemMutation, 'system' | 'entity' | 'id'>): string =>
  `${m.system}#${m.entity}#${m.id}`;

/** Keys that more than one mutation of `mutations` writes (empty when every key is unique). */
export function duplicateMutationKeys(mutations: SystemMutation[]): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const m of mutations) {
    const k = mutationKey(m);
    if (seen.has(k)) dup.add(k);
    seen.add(k);
  }
  return [...dup];
}

/**
 * Coalesce mutations per key so one transaction writes each row once (DynamoDB rejects a TransactWriteItems with
 * two operations on one item). Applying the result gives the same final state as applying the input in order:
 * the last mutation for a key wins (put-after-delete = put, delete-after-put = delete). Rows keep the position of
 * their last write.
 */
export function coalesceMutations(mutations: SystemMutation[]): SystemMutation[] {
  const last = new Map<string, number>();
  mutations.forEach((m, i) => last.set(mutationKey(m), i));
  return mutations.filter((m, i) => last.get(mutationKey(m)) === i);
}
