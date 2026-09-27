/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Audit logs (web): loading every page of a run's audit, fetching one LLM trace (inline or through its short-lived
 * URL), row summaries, client-side filters and the `.jsonl` export. Pure apart from the injected API calls.
 */
import type {
  AgentRole,
  AuditEntry,
  AuditEntryKind,
  AuditLlmEntry,
  AuditToolEntry,
  RunAuditResponse,
  RunMeta,
} from '@ica/schema/browser';
import { headline } from '../agents/headline';
import { roleName } from '../agents/roles';
import type { ApiClient } from '../lib/api';
import { actorLabel } from '../lib/format';

/** JSON above this is rendered on request ("Load full"), never cut. */
export const LARGE_JSON_BYTES = 1024 * 1024;

export interface AuditRun extends Omit<RunAuditResponse, 'entries' | 'nextCursor'> {
  entries: AuditEntry[];
}

/** Every page of `GET /runs/{id}/audit`, in order. */
export async function loadAudit(
  api: Pick<ApiClient, 'getRunAudit'>,
  runId: string,
  onPage?: (loaded: number, total: number) => void,
): Promise<AuditRun> {
  let cursor: string | undefined;
  let first: RunAuditResponse | undefined;
  const entries: AuditEntry[] = [];
  for (let guard = 0; guard < 1000; guard++) {
    const page = await api.getRunAudit(runId, cursor);
    first ??= page;
    entries.push(...page.entries);
    onPage?.(entries.length, page.total);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  const { entries: _e, nextCursor: _n, ...meta } = first!;
  return { ...meta, entries };
}

export interface LoadedTrace {
  key: string;
  sizeBytes: number;
  /** The stored trace object (request + response exactly as written). */
  trace: unknown;
}

/** One stored LLM trace; follows the presigned URL when the API answers with one (large traces). */
export async function loadLlmTrace(
  api: Pick<ApiClient, 'getRunAuditLlm'>,
  runId: string,
  key: string,
  fetchUrl: (url: string) => Promise<Response> = (url) => fetch(url),
): Promise<LoadedTrace> {
  const r = await api.getRunAuditLlm(runId, key);
  if (r.trace !== undefined) return { key: r.key, sizeBytes: r.sizeBytes, trace: r.trace };
  if (!r.url) throw new Error('The trace response had neither a body nor a URL');
  const res = await fetchUrl(r.url);
  if (!res.ok) throw new Error(`Could not download the trace (HTTP ${res.status})`);
  return { key: r.key, sizeBytes: r.sizeBytes, trace: (await res.json()) as unknown };
}

// ------------------------------------------------------------------------------------------------ display
export function agentLabel(e: Pick<AuditEntry, 'role' | 'agentRunId'>): string {
  if (e.role) return roleName(e.role);
  return e.agentRunId ?? 'Unknown agent';
}

/** "T3" (turn = iteration + 1), or "—". */
export function turnLabel(e: Pick<AuditEntry, 'iteration'>): string {
  return e.iteration === undefined ? '—' : `T${e.iteration + 1}`;
}

/** 4100 → "4.1k", 950 → "950". */
export function compactTokens(n: number | undefined): string {
  if (n === undefined) return '–';
  if (n < 1000) return String(n);
  if (n < 100_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return `${Math.round(n / 1000)}k`;
}

export function formatLatency(ms: number | undefined): string | null {
  if (ms === undefined) return null;
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export function formatUsd(n: number | undefined): string | null {
  if (n === undefined) return null;
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(3)}`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** "claude-sonnet-5 · 4.1k in / 440 out / 3.1k cache · 1.8 s · $0.0198" */
export function llmSummary(e: AuditLlmEntry): string {
  const parts: string[] = [e.model ?? 'model call'];
  if (e.usage) {
    const cache = e.usage.cacheReadTokens + e.usage.cacheWriteTokens;
    parts.push(
      `${compactTokens(e.usage.inputTokens)} in / ${compactTokens(e.usage.outputTokens)} out / ${compactTokens(cache)} cache`,
    );
  }
  const lat = formatLatency(e.latencyMs);
  if (lat) parts.push(lat);
  const cost = formatUsd(e.costUsd);
  if (cost) parts.push(cost);
  if (e.unmatched) parts.push('no model output recorded');
  return parts.join(' · ');
}

export function toolSummary(e: AuditToolEntry): string {
  return headline(e.tool, e.args, e.result, {
    minute: e.simMinute,
    failed: e.ok === false,
    ...(e.ok === false && (e.error ?? e.resultPreview) ? { error: e.error ?? e.resultPreview } : {}),
  });
}

export function entrySummary(e: AuditEntry): string {
  return e.kind === 'llm' ? llmSummary(e) : toolSummary(e);
}

/** The decision/outcome badge text of a tool entry, or null. */
export function outcomeLabel(
  e: AuditToolEntry,
): { text: string; tone: 'good' | 'warning' | 'critical' | 'neutral' } | null {
  if (e.blocked) return { text: 'Blocked', tone: 'critical' };
  if (e.decision) {
    const who = actorLabel(e.decision.decidedBy);
    if (e.decision.decision === 'reject') return { text: `Rejected · ${who}`, tone: 'critical' };
    return { text: `${e.decision.decision === 'edit' ? 'Edited' : 'Approved'} · ${who}`, tone: 'good' };
  }
  if (e.proposal) return { text: 'Awaiting decision', tone: 'warning' };
  if (e.ok === false) return { text: 'Error', tone: 'critical' };
  return null;
}

// ------------------------------------------------------------------------------------------------ filters
export interface AuditFilters {
  role: AgentRole | 'all';
  kind: AuditEntryKind | 'all';
  query: string;
}

export const NO_FILTERS: AuditFilters = { role: 'all', kind: 'all', query: '' };

const searchCache = new WeakMap<AuditEntry, string>();

/** Lower-cased text searched by the filter box: tool names, arguments, results, errors; model and summary. */
export function searchText(e: AuditEntry): string {
  let s = searchCache.get(e);
  if (s !== undefined) return s;
  s =
    e.kind === 'tool'
      ? [e.tool, e.system, safeJson(e.args), safeJson(e.result), e.resultPreview, e.error, e.toolCallId]
          .filter(Boolean)
          .join('\n')
      : [e.model, e.provider, e.summary, e.traceKey].filter(Boolean).join('\n');
  s = s.toLowerCase();
  searchCache.set(e, s);
  return s;
}

function safeJson(v: unknown): string {
  if (v === undefined) return '';
  try {
    return JSON.stringify(v);
  } catch {
    return '';
  }
}

export function filterEntries(entries: AuditEntry[], f: AuditFilters): AuditEntry[] {
  const q = f.query.trim().toLowerCase();
  return entries.filter(
    (e) =>
      (f.role === 'all' || e.role === f.role) &&
      (f.kind === 'all' || e.kind === f.kind) &&
      (!q || searchText(e).includes(q)),
  );
}

export function rolesIn(entries: AuditEntry[]): AgentRole[] {
  const seen = new Set<AgentRole>();
  for (const e of entries) if (e.role) seen.add(e.role);
  return [...seen];
}

// ------------------------------------------------------------------------------------------------ runs
/** The flight of a run when its title or scenario id names one ("ACX124"). */
export function flightOf(meta: Pick<RunMeta, 'scenarioTitle' | 'scenarioId'>): string | null {
  const m = /\bACX\d{3}\b/i.exec(`${meta.scenarioTitle} ${meta.scenarioId}`);
  return m ? m[0].toUpperCase() : null;
}

// ------------------------------------------------------------------------------------------------ export
/**
 * The run's audit as JSON lines: a header line, then one line per entry in order; LLM entries carry their full
 * stored trace (`trace`), fetched a few at a time. A trace that cannot be fetched is exported with `traceError`.
 */
export async function exportAuditJsonl(
  run: AuditRun,
  getTrace: (key: string) => Promise<unknown>,
  onProgress?: (done: number, total: number) => void,
  concurrency = 4,
): Promise<string> {
  const { entries, ...meta } = run;
  const lines: string[] = new Array(entries.length);
  let done = 0;
  let next = 0;
  onProgress?.(0, entries.length);
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= entries.length) return;
      const e = entries[i]!;
      let line: Record<string, unknown> = { ...e };
      if (e.kind === 'llm') {
        try {
          line = { ...e, trace: await getTrace(e.traceKey) };
        } catch (err) {
          line = { ...e, traceError: err instanceof Error ? err.message : String(err) };
        }
      }
      lines[i] = JSON.stringify(line);
      onProgress?.(++done, entries.length);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  const header = JSON.stringify({ kind: 'run', ...meta, exportedAt: new Date().toISOString() });
  return `${[header, ...lines].join('\n')}\n`;
}
