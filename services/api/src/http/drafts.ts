/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Training "write a scenario" drafts (async authoring): the API writes a `pending` draft and starts the author
 * asynchronously; the author (Lambda or in-process) finishes it here: validate, give it a fresh id if it clashes with
 * a shipped scenario, store it as private, and mark the draft `ready` — or `failed` with the errors.
 */
import {
  AUTHOR_DRAFT_STALE_MS,
  SCENARIO_IDS,
  validateScenario,
  type AuthorDraft,
  type AuthorResult,
  type Store,
} from '@ica/schema';

export function defaultDraftId(now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return `draft-${stamp}-${Math.random().toString(36).slice(2, 8).padEnd(6, '0')}`;
}

export async function completeAuthorDraft(
  store: Store,
  draftId: string,
  outcome: { result: AuthorResult } | { error: unknown },
  opts: { publicIds?: Iterable<string>; now?: () => Date } = {},
): Promise<AuthorDraft> {
  const now = (opts.now ?? (() => new Date()))().toISOString();
  const prev = await store.getAuthorDraft(draftId);
  const base: AuthorDraft = prev ?? {
    draftId,
    status: 'pending',
    createdAt: now,
    screening: { verdict: 'clean', findings: [] },
  };
  let out: AuthorDraft;
  if ('error' in outcome) {
    const msg = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
    out = { ...base, status: 'failed', errors: [`the Scenario Author failed: ${msg.slice(0, 300)}`] };
  } else {
    const r = outcome.result;
    const screening = r.screening ?? base.screening;
    const v = r.scenario ? validateScenario({ ...r.scenario, visibility: 'private' }) : null;
    if (v?.ok) {
      let scenario = v.value;
      const reserved = new Set<string>([...SCENARIO_IDS, ...(opts.publicIds ?? [])]);
      if (reserved.has(scenario.id)) {
        const suffix = `-a${Math.random().toString(36).slice(2, 6)}`;
        scenario = { ...scenario, id: `${scenario.id.slice(0, 64 - suffix.length)}${suffix}` };
      }
      await store.putScenario(scenario);
      out = { ...base, status: 'ready', screening, scenario };
      if (r.errors?.length) out.errors = r.errors;
      else delete out.errors;
    } else {
      const errors = [...(r.errors ?? []), ...(v && !v.ok ? v.errors : [])];
      out = {
        ...base,
        status: 'failed',
        screening,
        errors: errors.length ? errors.slice(0, 40) : ['the Scenario Author returned no scenario'],
      };
    }
  }
  out.updatedAt = now;
  await store.putAuthorDraft(out);
  return out;
}

/** A `pending` draft older than `AUTHOR_DRAFT_STALE_MS` is reported as failed (the author died or timed out). */
export function presentDraft(d: AuthorDraft, nowMs: number): AuthorDraft {
  if (d.status === 'pending' && nowMs - Date.parse(d.createdAt) > AUTHOR_DRAFT_STALE_MS)
    return { ...d, status: 'failed', errors: ['the Scenario Author did not finish in time'] };
  return d;
}
