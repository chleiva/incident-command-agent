/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Audit logs: `GET /runs/{id}/audit` (every LLM call and tool call of a run, chronological, paginated) and
 * `GET /runs/{id}/audit/llm?key=` (one stored LLM trace exactly as written, or a 5-minute presigned URL when it is
 * larger than the inline limit). Read-only: nothing here writes to the store or the traces bucket.
 */
import {
  AUDIT_LLM_INLINE_MAX_BYTES,
  AUDIT_PAGE_DEFAULT,
  AUDIT_PAGE_MAX,
  MAX_EVENTS_PAGE,
  auditRunName,
  buildAuditEntries,
  isRunTraceKey,
  type RunAuditLlmResponse,
  type RunAuditResponse,
  type RunEvent,
  type RunMeta,
  type Scenario,
  type TraceObjectInfo,
  type TraceStore,
} from '@ica/schema';
import { errorFields } from '../util/log';
import type { ApiDeps } from './deps';
import { HttpError, badRequest, notFound } from './errors';
import type { RouteContext, RouteResponse } from './router';

/** Presigned audit URLs live 5 minutes. */
export const AUDIT_PRESIGN_SECONDS = 300;

export interface AuditRouteHelpers {
  requireRun(ctx: RouteContext): Promise<RunMeta>;
  findScenario(id: string): Promise<Scenario | null>;
}

/** The run's flight: the airborne flight, else the first sector the incident aircraft operates. */
export function scenarioFlight(s: Scenario | null): string | undefined {
  if (!s) return undefined;
  return s.airborne?.flight ?? s.aircraft.nextSectors[0]?.flight;
}

/**
 * Events whose payload was offloaded (`{_truncated: true, preview}`, row over 32 KB) are rehydrated from
 * `traces/{runId}/{seq}.payload.json` (the `itemToEvent` layout). `DynamoStore.listEvents` normally does this
 * already; this is the belt-and-braces path for stores without a TraceStore.
 */
export async function rehydrateEvents(events: RunEvent[], traces: TraceStore): Promise<RunEvent[]> {
  return Promise.all(
    events.map(async (e) => {
      const p = e.payload as { _truncated?: unknown } | undefined;
      if (!p || p._truncated !== true) return e;
      try {
        const full = (await traces.get(`traces/${e.runId}/${e.seq}.payload.json`)) as RunEvent;
        return { ...e, payload: full.payload } as RunEvent;
      } catch {
        return e;
      }
    }),
  );
}

async function allEvents(deps: ApiDeps, runId: string): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  let after = 0;
  for (;;) {
    const page = await deps.store.listEvents(runId, after, MAX_EVENTS_PAGE);
    events.push(...page.events);
    if (!page.hasMore || !page.events.length) break;
    after = page.events.at(-1)!.seq;
  }
  return rehydrateEvents(events, deps.traces);
}

function parseCursor(raw: string | undefined): number {
  if (raw === undefined || raw === '') return 0;
  if (!/^\d{1,9}$/.test(raw)) throw badRequest('cursor is invalid');
  return Number(raw);
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined || raw === '') return AUDIT_PAGE_DEFAULT;
  if (!/^\d+$/.test(raw)) throw badRequest('limit must be a positive integer');
  const n = Number(raw);
  if (n < 1 || n > AUDIT_PAGE_MAX) throw badRequest(`limit must be between 1 and ${AUDIT_PAGE_MAX}`);
  return n;
}

export function createAuditRoutes(deps: ApiDeps, h: AuditRouteHelpers) {
  const inlineMax = deps.auditInlineMaxBytes ?? AUDIT_LLM_INLINE_MAX_BYTES;

  async function getRunAudit(ctx: RouteContext): Promise<RouteResponse> {
    const meta = await h.requireRun(ctx);
    const cursor = parseCursor(ctx.query.cursor);
    const limit = parseLimit(ctx.query.limit);
    const [events, listed, scenario] = await Promise.all([
      allEvents(deps, meta.runId),
      listTraces(deps.traces, meta.runId, ctx),
      h.findScenario(meta.scenarioId).catch(() => null),
    ]);
    const entries = buildAuditEntries(events, listed.items);
    const page = entries.slice(cursor, cursor + limit);
    const next = cursor + limit < entries.length ? String(cursor + limit) : undefined;
    const flight = scenarioFlight(scenario);
    const title = scenario?.title ?? meta.scenarioTitle;
    const first = events[0];
    const startSimTime = first
      ? new Date(Date.parse(first.simTime) - first.simMinute * 60_000).toISOString()
      : scenario?.startSimTime;
    const body: RunAuditResponse = {
      runId: meta.runId,
      runName: auditRunName(title, flight),
      scenarioId: meta.scenarioId,
      scenarioTitle: title,
      ...(flight ? { flight } : {}),
      mode: meta.mode,
      status: meta.status,
      createdAt: meta.createdAt,
      ...(startSimTime ? { startSimTime } : {}),
      total: entries.length,
      entries: page,
      ...(next ? { nextCursor: next } : {}),
      tracesListed: listed.ok,
    };
    ctx.annotate({ runId: meta.runId, auditEntries: page.length, auditTotal: entries.length });
    return { body };
  }

  async function getRunAuditLlm(ctx: RouteContext): Promise<RouteResponse> {
    const meta = await h.requireRun(ctx);
    const key = ctx.query.key ?? '';
    if (!key) throw badRequest('key is required');
    // Only this run's trace objects, never another run's and never a path traversal.
    if (!isRunTraceKey(meta.runId, key))
      throw new HttpError(400, 'invalid_trace_key', 'key is not a trace of this run');
    let trace: unknown;
    try {
      trace = await deps.traces.get(key);
    } catch (err) {
      ctx.log.warn('audit trace unavailable', { runId: meta.runId, key, ...errorFields(err) });
      throw notFound('trace', 'trace_not_found');
    }
    const sizeBytes = Buffer.byteLength(JSON.stringify(trace), 'utf8');
    ctx.annotate({ runId: meta.runId, traceKey: key, sizeBytes });
    if (sizeBytes > inlineMax && deps.presign) {
      const url = await deps.presign(key, { expiresIn: AUDIT_PRESIGN_SECONDS });
      return { body: { key, sizeBytes, url } satisfies RunAuditLlmResponse };
    }
    return { body: { key, sizeBytes, trace } satisfies RunAuditLlmResponse };
  }

  return { getRunAudit, getRunAuditLlm };
}

async function listTraces(
  traces: TraceStore,
  runId: string,
  ctx: RouteContext,
): Promise<{ ok: boolean; items: TraceObjectInfo[] }> {
  if (!traces.list) return { ok: false, items: [] };
  try {
    return { ok: true, items: await traces.list(runId) };
  } catch (err) {
    // Missing permission or a transient error: the audit still lists every call that has an event.
    ctx.log.warn('audit trace listing failed', { runId, ...errorFields(err) });
    return { ok: false, items: [] };
  }
}
