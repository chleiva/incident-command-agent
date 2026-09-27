/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Report robustness (live run 1): the model-facing report schema is relaxed (actionsTaken optional, unknown keys
 * allowed), unknown keys are kept under `extras`, actionsTaken is merged with the agent's executed tool calls,
 * placeholder reports are refused, and after repeated failures the runtime composes the report itself.
 */
import type { AgentRole, JSONSchema, RunEvent } from '@ica/schema';
import { validateAgainst } from '../guardrails/validate';
import type { RunContext } from './context';
import { preview } from './util';

/** Failed report attempts (schema or placeholder) before the runtime composes the report itself. */
export const MAX_REPORT_ATTEMPTS = 3;

/** Keys the runtime sets on a report; the model never sends them (they would land in `extras`). */
const RUNTIME_KEYS = new Set(['extras', 'composedByRuntime']);

type ObjectSchema = JSONSchema & {
  properties?: Record<string, JSONSchema>;
  required?: string[];
  additionalProperties?: unknown;
};

const relaxed = new WeakMap<object, JSONSchema>();

/**
 * The report schema as the model sees and the runtime validates it: `actionsTaken` is optional (the runtime fills it
 * from executed tool calls) and unknown keys are allowed (kept under `extras`). Every other required field stays
 * required. Cached per schema object so the compiled validator is reused.
 */
export function relaxReportSchema(schema: JSONSchema): JSONSchema {
  const hit = relaxed.get(schema);
  if (hit) return hit;
  const s = JSON.parse(JSON.stringify(schema)) as ObjectSchema;
  delete s.additionalProperties;
  if (Array.isArray(s.required)) s.required = s.required.filter((k) => k !== 'actionsTaken');
  if (s.properties?.actionsTaken)
    s.properties.actionsTaken = {
      ...s.properties.actionsTaken,
      description:
        'Optional. What you actually did, with ids. The runtime also appends the tool calls you executed.',
    };
  relaxed.set(schema, s);
  return s;
}

/** Split a report input into the keys the role schema defines and the rest (`extras`). */
export function splitExtras(
  input: Record<string, unknown>,
  schema: JSONSchema,
): { known: Record<string, unknown>; extras?: Record<string, unknown> } {
  const props = (schema as ObjectSchema).properties ?? {};
  const known: Record<string, unknown> = {};
  const extras: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (k in props) known[k] = v;
    else if (!RUNTIME_KEYS.has(k)) extras[k] = v;
  }
  if (!Object.keys(extras).length) return { known };
  // Keep the event small: an oversized value is kept as a truncated JSON preview.
  const capped = Object.fromEntries(
    Object.entries(extras)
      .slice(0, 20)
      .map(([k, v]) => {
        const json = JSON.stringify(v) ?? '';
        return [k.slice(0, 80), json.length > 2000 ? preview(v, 2000) : v];
      }),
  );
  return { known, extras: capped };
}

const PLACEHOLDER = /^\s*(test|testing|placeholder|todo|n\/a|tbd|lorem|dummy)\b/i;
export const MIN_SUMMARY_CHARS = 20;
const LIST_KEYS = ['actionsTaken', 'openIssues', 'recommendations'] as const;

/** Degenerate/placeholder content in a report (empty when the report is acceptable). */
export function placeholderProblems(input: Record<string, unknown>): string[] {
  const out: string[] = [];
  const summary = typeof input.summary === 'string' ? input.summary.trim() : '';
  if (PLACEHOLDER.test(summary)) out.push('summary is placeholder text');
  else if (summary.length < MIN_SUMMARY_CHARS)
    out.push(`summary is too short (${summary.length} chars; at least ${MIN_SUMMARY_CHARS})`);
  for (const k of LIST_KEYS) {
    const items = Array.isArray(input[k]) ? (input[k] as unknown[]) : [];
    if (items.length && items.every((x) => typeof x === 'string' && PLACEHOLDER.test(x)))
      out.push(`${k} contains only placeholder items`);
  }
  return out;
}

export function isPlaceholderItem(x: string): boolean {
  return PLACEHOLDER.test(x);
}

/** One executed tool call of an agent (from the run's event log). */
export interface ExecutedAction {
  tool: string;
  text: string;
  /** Lower-case tokens that show a model-written item already covers this action. */
  markers: string[];
}

const ID_KEY = /(^id$|Id$|Ids$|^role$|^tail$|^station$|^flight$)/;

function idValues(obj: unknown, depth = 0): string[] {
  if (!obj || typeof obj !== 'object' || depth > 1) return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (ID_KEY.test(k) && typeof v === 'string' && v.length >= 2) out.push(v);
    else if (ID_KEY.test(k) && Array.isArray(v))
      out.push(...v.filter((x): x is string => typeof x === 'string'));
    else if (v && typeof v === 'object' && !Array.isArray(v)) out.push(...idValues(v, depth + 1));
  }
  return out;
}

/** `page_engineer` → `engineer`; `get_aircraft_status` → `aircraft status`. */
function toolObject(tool: string): string {
  const words = tool.split('_');
  return (words.length > 1 ? words.slice(1) : words).join(' ');
}

/** The agent's own successful tool calls (not report), in order, deduplicated. */
export function executedActions(ctx: RunContext, agentRunId: string): ExecutedAction[] {
  const events = ctx.eventLog().filter((e) => e.agentRunId === agentRunId);
  const calls = new Map<string, RunEvent<'agent.tool_call'>>();
  for (const e of events) if (e.type === 'agent.tool_call') calls.set(e.payload.toolCallId, e as never);
  const out: ExecutedAction[] = [];
  const seen = new Set<string>();
  for (const e of events) {
    if (e.type !== 'agent.tool_result') continue;
    const r = (e as RunEvent<'agent.tool_result'>).payload;
    if (!r.ok || r.tool === 'report') continue;
    const call = calls.get(r.toolCallId);
    const ids = [...new Set([...idValues(call?.payload.args), ...idValues(r.result)])].slice(0, 4);
    const args = call?.payload.args ?? {};
    const role = r.tool === 'delegate' && typeof args.role === 'string' ? ` ${args.role}` : '';
    const outcome = r.tool === 'delegate' ? 'report received' : preview(r.result ?? r.resultPreview, 90);
    const text = `${r.tool}${role}${ids.length && !role ? ` (${ids.join(', ')})` : ''}: ${outcome}`.slice(
      0,
      240,
    );
    if (seen.has(text)) continue;
    seen.add(text);
    out.push({
      tool: r.tool,
      text,
      markers: [r.tool, toolObject(r.tool), ...ids, ...(role ? [role.trim()] : [])]
        .map((m) => m.toLowerCase())
        .filter((m) => m.length >= 2),
    });
  }
  return out;
}

/**
 * actionsTaken = the model's items (placeholders dropped) + every executed action no model item mentions (by tool
 * name, the tool's object words or an id it touched). The runtime's list is authoritative-supplementary.
 */
export function mergeActions(model: unknown, executed: ExecutedAction[]): string[] {
  const own = (Array.isArray(model) ? model : [])
    .map((x) => (typeof x === 'string' ? x : JSON.stringify(x)))
    .filter((x) => x.trim() && !isPlaceholderItem(x));
  const lower = own.map((x) => x.toLowerCase());
  const missing = executed.filter((a) => !lower.some((t) => a.markers.some((m) => t.includes(m))));
  return [...own, ...missing.map((a) => a.text)].slice(0, 60);
}

/**
 * The runtime's report after repeated invalid attempts: the last attempt's fields that are individually valid
 * (placeholders dropped), plus the executed actions, marked `composedByRuntime`.
 */
export function composeRuntimeReport(
  role: AgentRole,
  lastInput: Record<string, unknown> | undefined,
  schema: JSONSchema,
  executed: ExecutedAction[],
  failures: number,
): Record<string, unknown> {
  const props = (schema as ObjectSchema).properties ?? {};
  const { known, extras } = splitExtras(lastInput ?? {}, schema);
  const kept: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(known)) {
    if (props[k] && validateAgainst(props[k], v).ok) kept[k] = v;
  }
  const summary =
    typeof kept.summary === 'string' && !placeholderProblems({ summary: kept.summary }).length
      ? kept.summary
      : `The ${role} agent did not return a valid report; the runtime composed this report from its recorded tool calls.`;
  const list = (k: string) =>
    (Array.isArray(kept[k]) ? (kept[k] as unknown[]) : []).filter(
      (x): x is string => typeof x === 'string' && !isPlaceholderItem(x),
    );
  return {
    ...kept,
    summary,
    actionsTaken: mergeActions(kept.actionsTaken, executed),
    openIssues: [
      ...list('openIssues'),
      `The ${role} agent's report was rejected ${failures} times; this report was composed by the runtime. Verify its findings before relying on them.`,
    ],
    recommendations: list('recommendations'),
    citations: Array.isArray(kept.citations) ? kept.citations : [],
    ...(extras ? { extras } : {}),
    composedByRuntime: true,
  };
}
