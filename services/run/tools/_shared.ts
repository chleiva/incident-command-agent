/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** Shared pieces for the domain tools: schema fragments, outcome helpers, approver resolution, knowledge search. */
import { bestQuote } from '@ica/kb';
import {
  FLIGHT_NUMBER_PATTERN,
  IATA_PATTERN,
  TAIL_PATTERN,
  type Actor,
  type Citation,
  type Jurisdiction,
  type KnowledgeCollection,
  type SystemMutation,
  type ToolContext,
  type ToolOutcome,
} from '@ica/schema';
import type { Result } from '../systems/util';

// ---------------------------------------------------------------- schema fragments (strict, bounded)
export const S = {
  tail: { type: 'string', pattern: TAIL_PATTERN, description: 'Tail, e.g. AX-ABC' },
  flight: { type: 'string', pattern: FLIGHT_NUMBER_PATTERN, description: 'Flight number, e.g. ACX123' },
  station: { type: 'string', pattern: IATA_PATTERN, description: 'IATA station code, e.g. MAN' },
  id: { type: 'string', minLength: 1, maxLength: 48, pattern: '^[A-Za-z0-9:_.#-]+$' },
  melItem: {
    type: 'string',
    pattern: '^\\d{2}-\\d{2}-\\d{2}[A-Z]?$',
    description: 'MEL/MMEL item, e.g. 49-10-01',
  },
  query: { type: 'string', minLength: 2, maxLength: 300 },
  k: { type: 'integer', minimum: 1, maximum: 8, description: 'Number of results (default 4)' },
  jurisdiction: { type: 'string', enum: ['EU', 'UK', 'US'] },
  requestId: {
    type: 'string',
    minLength: 8,
    maxLength: 64,
    pattern: '^[A-Za-z0-9-]+$',
    description:
      'Client-generated UUID for this request (idempotency key). Generate a new one per request; reuse it ONLY when retrying the same request, which then returns the original result without acting twice.',
  },
} as const;

export function obj(
  properties: Record<string, unknown>,
  required: string[] = [],
  extra: Record<string, unknown> = {},
): { type: 'object'; properties: Record<string, unknown>; required: string[]; additionalProperties: false } {
  return { type: 'object', properties, required, additionalProperties: false, ...extra };
}

export const arrayOf = (items: unknown, maxItems = 20, minItems = 1) => ({
  type: 'array',
  items,
  minItems,
  maxItems,
  uniqueItems: true,
});

// ---------------------------------------------------------------- outcomes
export const ok = <O>(data: O, mutations?: SystemMutation[], citations?: Citation[]): ToolOutcome<O> => {
  const out: ToolOutcome<O> = { ok: true, data };
  if (mutations?.length) out.mutations = mutations;
  if (citations?.length) out.citations = citations;
  return out;
};
export const err = (error: string): ToolOutcome<never> => ({ ok: false, error });

/** Turn a system helper result into a tool outcome, shaping the data. */
export function fromResult<T, O>(r: Result<T>, shape: (v: T) => O): ToolOutcome<O> {
  return r.ok ? ok(shape(r.value), r.mutations) : err(r.error);
}

/**
 * The actor who approved a `propose`-tier call: the runtime's `approvedBy`, or the calling actor itself when that is
 * a human or a policy (baseline mode). Undefined for a bare agent call.
 */
export function approverOf(ctx: ToolContext): Actor | undefined {
  // Prefer a named human: the approving person, else a human caller (baseline mode), else the approving policy.
  if (ctx.approvedBy?.kind === 'human') return ctx.approvedBy;
  if (ctx.actor.kind === 'human') return ctx.actor;
  if (ctx.approvedBy) return ctx.approvedBy;
  return ctx.actor.kind === 'agent' ? undefined : ctx.actor;
}

/** Defence in depth for `propose` tools: refuse to act without an approval. */
export function requireApproval(ctx: ToolContext): string | undefined {
  return approverOf(ctx)
    ? undefined
    : 'this action needs a human decision: it runs only after the proposal is approved';
}

/** The incident station (scenario aircraft station). */
export const incidentStation = (ctx: ToolContext) => ctx.scenario.aircraft.station;

// ---------------------------------------------------------------- idempotency (task 06 §1.9)
/** JSON pointer of the idempotency key on notification and work-order tools. */
export const REQUEST_ID_KEY = '/requestId';

/** Entities of `state[system][entity]` created by the call with this `requestId` (field name configurable). */
export function byRequestId<T>(
  map: Record<string, T> | undefined,
  requestId: string | undefined,
  field = 'requestId',
): T[] {
  if (!requestId || !map) return [];
  return Object.values(map).filter((x) => (x as Record<string, unknown>)[field] === requestId);
}

/** Stamp `requestId` on the `after` of the mutations of one entity map (the entities this call created or set). */
export function tagRequest(
  mutations: SystemMutation[],
  system: string,
  entity: string,
  requestId: string | undefined,
  field = 'requestId',
  ops: SystemMutation['op'][] = ['create'],
): SystemMutation[] {
  if (!requestId) return mutations;
  return mutations.map((m) =>
    m.system === system && m.entity === entity && ops.includes(m.op) && m.after
      ? { ...m, after: { ...m.after, [field]: requestId } }
      : m,
  );
}

/** A repeat of an already-applied request: the original result shape, no mutations. */
export function replayed<O>(data: O): ToolOutcome<O & { deduplicated: true }> {
  return { ok: true, data: { ...data, deduplicated: true as const } };
}

// ---------------------------------------------------------------- knowledge
export const ASRS_NOTE =
  'ASRS reports are voluntary and unverified (NASA disclaimer); treat them as illustrations, not statistics.';

export async function knowledgeSearch(
  ctx: ToolContext,
  input: { query: string; k?: number; jurisdiction?: Jurisdiction },
  collections: KnowledgeCollection[],
): Promise<ToolOutcome<{ hits: unknown[]; note?: string }>> {
  const hits = await ctx.knowledge.search({
    query: input.query,
    collections,
    jurisdiction: input.jurisdiction,
    k: input.k ?? 4,
  });
  const citations: Citation[] = hits.map((h) => ({
    sourceId: h.sourceId,
    url: h.url,
    title: h.title,
    quote: bestQuote(h.text, input.query, 300),
    chunkId: h.chunkId,
  }));
  const data: { hits: unknown[]; note?: string } = {
    hits: hits.map((h, i) => ({
      chunkId: h.chunkId,
      sourceId: h.sourceId,
      title: h.title,
      ...(h.section ? { section: h.section } : {}),
      ...(h.jurisdiction ? { jurisdiction: h.jurisdiction } : {}),
      ...(h.date ? { date: h.date } : {}),
      // Structural context (source › section › jurisdiction › date; report synopsis / MEL item header): not quotable.
      ...(h.header ? { context: h.header } : {}),
      quote: citations[i].quote,
      excerpt: h.text.length > 900 ? `${h.text.slice(0, 900)}…` : h.text,
    })),
  };
  if (!hits.length) data.note = 'No matching documents. Do not state rules or limits without a citation.';
  else if (hits.some((h) => h.sourceId.startsWith('ASRS'))) data.note = ASRS_NOTE;
  return ok(data, undefined, citations);
}

export const knowledgeInput = (withJurisdiction = true) =>
  obj(
    {
      query: {
        ...S.query,
        description: 'What to look for, in plain words (e.g. "APU inoperative dispatch")',
      },
      k: S.k,
      ...(withJurisdiction ? { jurisdiction: S.jurisdiction } : {}),
    },
    ['query'],
  );
