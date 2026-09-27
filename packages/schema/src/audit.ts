/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Audit logs (addition): one chronological list of every LLM call and every tool call of a run, built from the
 * run's events and the list of its stored trace objects. Pure and browser-safe: the API (`GET /runs/{id}/audit`) and
 * the web mock backend share it. LLM entries carry metadata and a `traceKey` only; the full request/response is
 * fetched one at a time (`GET /runs/{id}/audit/llm?key=`).
 */
import type { Citation } from './common';
import type { RunEvent } from './events';
import { AGENT_ROLES, type Actor, type AgentRole, type RunMode, type RunStatus, type Tier } from './ids';
import type { TraceObjectInfo } from './persistence';

/** Default and maximum entries per `GET /runs/{id}/audit` page. */
export const AUDIT_PAGE_DEFAULT = 500;
export const AUDIT_PAGE_MAX = 2000;
/** Above this, `GET /runs/{id}/audit/llm` answers with a presigned URL (API Gateway/Lambda response limits). */
export const AUDIT_LLM_INLINE_MAX_BYTES = 5 * 1024 * 1024;

export interface AuditUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

interface AuditEntryBase {
  /** Stable id: `llm:{traceKey}` or `tool:{toolCallId}`. */
  id: string;
  agentRunId?: string;
  role?: AgentRole;
  /** 0-based agent iteration (the UI shows turn `T{iteration + 1}`). */
  iteration?: number;
  /** The event the entry is anchored on (`agent.thought` for LLM calls, `agent.tool_call` for tools). */
  seq?: number;
  simMinute?: number;
  simTime?: string;
  wallTime?: string;
}

export interface AuditLlmEntry extends AuditEntryBase {
  kind: 'llm';
  /** `traces/{runId}/{agentRunId}-i{nnn}.json` */
  traceKey: string;
  provider?: string;
  model?: string;
  usage?: AuditUsage;
  costUsd?: number;
  latencyMs?: number;
  /** Stored object size in bytes, when the trace store knows it. */
  sizeBytes?: number;
  /** The `agent.thought` summary of this call's model output (≤ 120 chars). */
  summary?: string;
  /** No `agent.thought` refers to this trace: the call failed (the trace then has `error`) or is in flight. */
  unmatched?: boolean;
}

export interface AuditBlock {
  layer: string;
  reason: string;
  rule?: string;
  authority?: string;
  seq: number;
}

export interface AuditProposal {
  approvalId: string;
  summary: string;
  seq: number;
}

export interface AuditDecision {
  decision: 'approve' | 'edit' | 'reject';
  decidedBy: Actor;
  reason?: string;
  editedArgs?: Record<string, unknown>;
  selectedOptionId?: string;
  seq: number;
  simMinute: number;
}

export interface AuditToolEntry extends AuditEntryBase {
  kind: 'tool';
  toolCallId: string;
  tool: string;
  system?: string;
  /** Absent when the call was blocked before `agent.tool_call` (e.g. an unknown tool). */
  tier?: Tier;
  args?: Record<string, unknown>;
  ok?: boolean;
  /** The full result (rehydrated when the event was offloaded to the TraceStore). */
  result?: unknown;
  resultPreview?: string;
  /** The error text of a failed call (`resultPreview` of a result with `ok: false`, or the guardrail reason). */
  error?: string;
  latencyMs?: number;
  resultSeq?: number;
  normalisedFrom?: string;
  argsRepaired?: string[];
  argsTruncated?: string[];
  presenterTriggered?: boolean;
  deduplicatedFrom?: string;
  /** Addition (demo review): a cached read-only result (the original call's id). */
  cachedFrom?: string;
  citations?: Citation[];
  blocked?: AuditBlock;
  proposal?: AuditProposal;
  decision?: AuditDecision;
}

export type AuditEntry = AuditLlmEntry | AuditToolEntry;
export type AuditEntryKind = AuditEntry['kind'];

/** `GET /runs/{id}/audit?cursor=&limit=` */
export interface RunAuditResponse {
  runId: string;
  /** Scenario title, plus the flight when it is not already in the title. */
  runName: string;
  scenarioId: string;
  scenarioTitle: string;
  flight?: string;
  mode: RunMode;
  status: RunStatus;
  createdAt: string;
  /** ISO time of sim minute 0 (from the first event), for sim-clock labels. */
  startSimTime?: string;
  /** Entries in the whole run (all pages). */
  total: number;
  entries: AuditEntry[];
  /** Pass as `cursor` for the next page; absent on the last page. */
  nextCursor?: string;
  /** False when the trace store cannot list objects (LLM entries then come from events only). */
  tracesListed: boolean;
}

/** `GET /runs/{id}/audit/llm?key=` — the stored trace exactly as written, or a short-lived URL to it. */
export interface RunAuditLlmResponse {
  key: string;
  sizeBytes: number;
  trace?: unknown;
  /** Presigned GET URL (5 minutes) when the trace is larger than `AUDIT_LLM_INLINE_MAX_BYTES`. */
  url?: string;
}

/** LLM call trace objects are `{agentRunId}-i{nnn}.json`; payload offloads (`.payload`) and exports are not. */
const LLM_LABEL = /^traces\/[A-Za-z0-9._-]+\/([A-Za-z0-9._-]+)-i(\d{1,6})\.json$/;

/** Parse an LLM trace key into its agent run and iteration; `null` for any other trace object. */
export function parseLlmTraceKey(key: string): { agentRunId: string; iteration: number } | null {
  const m = LLM_LABEL.exec(key);
  if (!m || m[1]!.endsWith('.payload')) return null;
  return { agentRunId: m[1]!, iteration: Number(m[2]) };
}

/** True when `key` is a well-formed trace key of `runId` (`traces/{runId}/{name}.json`, no traversal). */
export function isRunTraceKey(runId: string, key: string): boolean {
  if (key.includes('..') || key.includes('\\') || key.includes('//')) return false;
  const prefix = `traces/${runId}/`;
  if (!key.startsWith(prefix)) return false;
  return /^[A-Za-z0-9._-]+\.json$/.test(key.slice(prefix.length));
}

const ROLE_SET = new Set<string>(AGENT_ROLES);

function roleFromAgentRunId(agentRunId: string): AgentRole | undefined {
  if (agentRunId.startsWith('author')) return 'author';
  const m = /^ar-([a-z]+)-/.exec(agentRunId);
  return m && ROLE_SET.has(m[1]!) ? (m[1] as AgentRole) : undefined;
}

function actorRole(e: RunEvent): AgentRole | undefined {
  return e.actor.kind === 'agent' ? e.actor.role : undefined;
}

function when(e: RunEvent) {
  return { seq: e.seq, simMinute: e.simMinute, simTime: e.simTime, wallTime: e.wallTime };
}

/**
 * Build the chronological audit of a run. `events` must be the run's full event list (payloads rehydrated);
 * `traces` the objects listed under `traces/{runId}/` (may be empty: every `agent.thought.traceKey` still yields an
 * LLM entry). Anchored entries sort by seq; LLM traces with no `agent.thought` are placed by write time.
 */
export function buildAuditEntries(events: RunEvent[], traces: TraceObjectInfo[] = []): AuditEntry[] {
  const roles = new Map<string, AgentRole>();
  for (const e of events) {
    if (e.type === 'agent.started' && e.agentRunId) roles.set(e.agentRunId, e.payload.role);
  }
  const roleOf = (agentRunId: string | undefined, e?: RunEvent): AgentRole | undefined =>
    (agentRunId ? roles.get(agentRunId) : undefined) ??
    (e ? actorRole(e) : undefined) ??
    (agentRunId ? roleFromAgentRunId(agentRunId) : undefined);

  const llm = new Map<string, AuditLlmEntry>();
  const listed = new Map(traces.map((t) => [t.key, t]));
  for (const e of events) {
    if (e.type !== 'agent.thought' || !e.traceKey) continue;
    const info = listed.get(e.traceKey);
    const parsed = parseLlmTraceKey(e.traceKey);
    const u = e.usage;
    llm.set(e.traceKey, {
      kind: 'llm',
      id: `llm:${e.traceKey}`,
      traceKey: e.traceKey,
      ...(e.agentRunId ? { agentRunId: e.agentRunId } : {}),
      ...optRole(roleOf(e.agentRunId, e)),
      iteration: e.iteration ?? parsed?.iteration,
      ...when(e),
      ...(u
        ? {
            provider: u.provider,
            model: u.model,
            usage: {
              inputTokens: u.inputTokens,
              outputTokens: u.outputTokens,
              cacheReadTokens: u.cacheReadTokens,
              cacheWriteTokens: u.cacheWriteTokens,
            },
            costUsd: u.costUsd,
          }
        : {}),
      ...(e.latencyMs !== undefined ? { latencyMs: e.latencyMs } : {}),
      ...(info?.size !== undefined ? { sizeBytes: info.size } : {}),
      summary: e.payload.summary,
    });
  }
  const unanchored: AuditLlmEntry[] = [];
  for (const t of traces) {
    if (llm.has(t.key)) continue;
    const parsed = parseLlmTraceKey(t.key);
    if (!parsed) continue;
    const entry: AuditLlmEntry = {
      kind: 'llm',
      id: `llm:${t.key}`,
      traceKey: t.key,
      agentRunId: parsed.agentRunId,
      ...optRole(roleOf(parsed.agentRunId)),
      iteration: parsed.iteration,
      ...(t.lastModified ? { wallTime: t.lastModified } : {}),
      ...(t.size !== undefined ? { sizeBytes: t.size } : {}),
      unmatched: true,
    };
    llm.set(t.key, entry);
    unanchored.push(entry);
  }

  // ------------------------------------------------------------------ tools
  const tools = new Map<string, AuditToolEntry>();
  const byApproval = new Map<string, AuditToolEntry>();
  const blocks: RunEvent<'guardrail.blocked'>[] = [];
  const decisions: RunEvent<'approval.decision'>[] = [];
  for (const e of events) {
    switch (e.type) {
      case 'agent.tool_call': {
        const p = e.payload;
        tools.set(p.toolCallId, {
          kind: 'tool',
          id: `tool:${p.toolCallId}`,
          toolCallId: p.toolCallId,
          tool: p.tool,
          system: p.system,
          tier: p.tier,
          args: p.args,
          ...(e.agentRunId ? { agentRunId: e.agentRunId } : {}),
          ...optRole(roleOf(e.agentRunId, e)),
          ...(e.iteration !== undefined ? { iteration: e.iteration } : {}),
          ...when(e),
          ...(p.normalisedFrom ? { normalisedFrom: p.normalisedFrom } : {}),
          ...(p.argsRepaired?.length ? { argsRepaired: p.argsRepaired } : {}),
          ...(p.argsTruncated?.length ? { argsTruncated: p.argsTruncated } : {}),
          ...(p.presenterTriggered ? { presenterTriggered: true } : {}),
        });
        break;
      }
      case 'agent.tool_result': {
        const t = tools.get(e.payload.toolCallId);
        if (!t) break;
        const p = e.payload;
        t.ok = p.ok;
        t.resultSeq = e.seq;
        t.resultPreview = p.resultPreview;
        if (p.result !== undefined) t.result = p.result;
        if (!p.ok) t.error = p.resultPreview;
        if (e.latencyMs !== undefined) t.latencyMs = e.latencyMs;
        if (p.citations?.length) t.citations = p.citations;
        if (p.deduplicatedFrom) t.deduplicatedFrom = p.deduplicatedFrom;
        if (p.cachedFrom) t.cachedFrom = p.cachedFrom;
        break;
      }
      case 'guardrail.blocked':
        if (e.payload.toolCallId) blocks.push(e);
        break;
      case 'agent.proposal': {
        const t = tools.get(e.payload.toolCallId);
        if (!t) break;
        t.proposal = { approvalId: e.payload.approvalId, summary: e.payload.summary, seq: e.seq };
        byApproval.set(e.payload.approvalId, t);
        break;
      }
      case 'approval.decision':
        decisions.push(e);
        break;
      default:
        break;
    }
  }
  for (const e of blocks) {
    const p = e.payload;
    const block: AuditBlock = {
      layer: p.layer,
      reason: p.reason,
      ...(p.rule ? { rule: p.rule } : {}),
      ...(p.authority ? { authority: p.authority } : {}),
      seq: e.seq,
    };
    const t = tools.get(p.toolCallId!);
    if (t) {
      t.blocked = block;
      t.error ??= p.reason;
      continue;
    }
    // Blocked before `agent.tool_call` (unknown tool, tier gate on a synthetic call): an entry of its own.
    tools.set(p.toolCallId!, {
      kind: 'tool',
      id: `tool:${p.toolCallId}`,
      toolCallId: p.toolCallId!,
      tool: p.tool ?? 'unknown',
      ...(e.agentRunId ? { agentRunId: e.agentRunId } : {}),
      ...optRole(roleOf(e.agentRunId, e)),
      ...(e.iteration !== undefined ? { iteration: e.iteration } : {}),
      ...when(e),
      ok: false,
      error: p.reason,
      blocked: block,
      ...(p.presenterTriggered ? { presenterTriggered: true } : {}),
    });
  }
  for (const e of decisions) {
    const t = byApproval.get(e.payload.approvalId);
    if (!t) continue;
    const p = e.payload;
    t.decision = {
      decision: p.decision,
      decidedBy: p.decidedBy,
      ...(p.reason ? { reason: p.reason } : {}),
      ...(p.editedArgs ? { editedArgs: p.editedArgs } : {}),
      ...(p.selectedOptionId ? { selectedOptionId: p.selectedOptionId } : {}),
      seq: e.seq,
      simMinute: e.simMinute,
    };
  }

  // ------------------------------------------------------------------ order
  const anchored: AuditEntry[] = [...llm.values(), ...tools.values()].filter((x) => x.seq !== undefined);
  anchored.sort((a, b) => a.seq! - b.seq! || (a.kind === b.kind ? 0 : a.kind === 'llm' ? -1 : 1));
  if (!unanchored.length) return anchored;
  unanchored.sort((a, b) => (a.wallTime ?? '').localeCompare(b.wallTime ?? '') || a.id.localeCompare(b.id));
  const out: AuditEntry[] = [];
  let i = 0;
  for (const u of unanchored) {
    while (i < anchored.length && u.wallTime && (anchored[i]!.wallTime ?? '') <= u.wallTime)
      out.push(anchored[i++]!);
    if (!u.wallTime) continue;
    out.push(u);
  }
  out.push(...anchored.slice(i));
  // Unanchored traces with no time at all go last, in key order.
  out.push(...unanchored.filter((u) => !u.wallTime));
  return out;
}

function optRole(role: AgentRole | undefined): { role?: AgentRole } {
  return role ? { role } : {};
}

/** "Disruptive passenger: ACX124 at LGW" (flight already in the title) or "Pushback damage · ACX101". */
export function auditRunName(title: string, flight?: string): string {
  if (!flight || title.toUpperCase().includes(flight.toUpperCase())) return title;
  return `${title} · ${flight}`;
}
