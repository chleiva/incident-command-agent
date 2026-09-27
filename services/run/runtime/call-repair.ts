/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Deterministic repairs of model tool calls, applied by the loop BEFORE validation (both are recorded on the
 * `agent.tool_call` event, so they stay auditable; the call still passes arg/ref validation and the tier gate):
 *
 * - `normaliseRoleCall`: a tool named after a role the agent may delegate to (`ground{brief}`) becomes
 *   `delegate{role: 'ground', brief}` under the SAME tool_use id (live run 1: parallel delegation was blocked as
 *   "unknown tool").
 * - `repairLeakedParameters`: a string argument that swallowed the next parameters as tool-call markup
 *   (`"…</parameter>\n<parameter name=\"actionsTaken\">[…]"`, live run 1; `"…</summary> <openIssues>[…]"`,
 *   live run 2) is split back into its keys using the tool's own argument names.
 */
import type { AgentRole } from '@ica/schema';
import type { ToolCallInput } from './execute';

/** Minimal view of a tool's JSON Schema used by the repair (top-level properties and their types). */
export interface ArgsSchemaView {
  properties?: Record<string, { type?: string | string[] } | undefined>;
}

const IDENT = '[A-Za-z_][A-Za-z0-9_]*';
/** `<parameter name="k">` (quotes optionally JSON-escaped). */
const PARAM_OPEN = new RegExp(`<parameter\\s+name=\\\\?"(${IDENT})\\\\?"\\s*>`, 'g');
const TRAILING_CLOSE = /\s*(<\/parameter>|<\/invoke>|<\/function_calls>)\s*$/;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function typesOf(schema: ArgsSchemaView | undefined, key: string): string[] {
  const t = schema?.properties?.[key]?.type;
  return t === undefined ? [] : Array.isArray(t) ? t : [t];
}

function matchesType(value: unknown, types: string[]): boolean {
  if (!types.length) return value !== undefined && value !== '';
  return types.some((t) =>
    t === 'array'
      ? Array.isArray(value)
      : t === 'object'
        ? !!value && typeof value === 'object' && !Array.isArray(value)
        : t === 'integer'
          ? Number.isInteger(value)
          : t === 'null'
            ? value === null
            : typeof value === t && value !== '',
  );
}

function parseLoose(raw: string, types: string[] = []): unknown {
  const t = raw.trim();
  if (!t) return t;
  const wantsJson = types.some((x) =>
    ['array', 'object', 'number', 'integer', 'boolean', 'null'].includes(x),
  );
  const onlyString = types.length > 0 && types.every((x) => x === 'string');
  if (onlyString) return t;
  if (wantsJson || /^[[{"]|^-?\d|^(true|false|null)$/.test(t)) {
    try {
      return JSON.parse(t);
    } catch {
      // trailing junk after the JSON value (`["a","b"] and then…`): parse up to the last matching bracket
      const close = t.startsWith('[') ? ']' : t.startsWith('{') ? '}' : '';
      for (let end = close ? t.lastIndexOf(close) : -1; end > 0; end = t.lastIndexOf(close, end - 1)) {
        try {
          return JSON.parse(t.slice(0, end + 1));
        } catch {
          /* try a shorter prefix */
        }
      }
    }
  }
  return t;
}

/**
 * The leak markers for one string value of key `self`: `</parameter><parameter name="k2">`, `</self>`, and the
 * opening/closing tags of the tool's OTHER argument names (`<k2>`, `</k2>`). Without a schema only the
 * `<parameter name=…>` form is recognised (an arbitrary `<tag>` in free text is never treated as markup).
 */
function markerRe(self: string, known: string[]): RegExp {
  const names = [...new Set([self, ...known])].map(escapeRe);
  const tagAlt = names.length ? `|<\\/?(?:${names.join('|')})\\s*>` : '';
  return new RegExp(`<\\/parameter>|<parameter\\s+name=\\\\?"${IDENT}\\\\?"\\s*>${tagAlt}`, 'g');
}

/** Split a leaked tail into `[key, raw]` segments using opening tags of known keys / `<parameter name>`. */
function segments(tail: string, known: string[]): [string, string][] {
  const opens: { key: string; start: number; end: number }[] = [];
  for (const m of tail.matchAll(PARAM_OPEN))
    opens.push({ key: m[1]!, start: m.index, end: m.index + m[0].length });
  if (known.length) {
    const re = new RegExp(`<(${known.map(escapeRe).join('|')})\\s*>`, 'g');
    for (const m of tail.matchAll(re)) opens.push({ key: m[1]!, start: m.index, end: m.index + m[0].length });
  }
  opens.sort((a, b) => a.start - b.start);
  const out: [string, string][] = [];
  opens.forEach((o, i) => {
    let raw = tail.slice(o.end, i + 1 < opens.length ? opens[i + 1]!.start : undefined);
    // cut at this key's closing tag (or `</parameter>`) when present
    const close = new RegExp(`<\\/(?:${escapeRe(o.key)}|parameter)\\s*>`).exec(raw);
    if (close) raw = raw.slice(0, close.index);
    out.push([o.key, raw.replace(TRAILING_CLOSE, '')]);
  });
  return out;
}

/**
 * Recover arguments the model leaked into a string value as tool-call markup, for ANY tool. Recognised shapes:
 * `…</parameter>\n<parameter name="k2">…` (live run 1) and `…</summary> <openIssues>[…] …` (live run 2), and
 * their variants (`<k2>…</k2>`, missing closing tags). With the tool's schema, the other argument names are the
 * only tags treated as markup, and array/object/number values are JSON-parsed. Only top-level string values are
 * inspected; a recovered key never overwrites a key the model already provided validly.
 */
export function repairLeakedParameters(
  input: Record<string, unknown>,
  schema?: ArgsSchemaView,
): {
  input: Record<string, unknown>;
  repaired: string[];
} {
  const known = Object.keys(schema?.properties ?? {});
  const out: Record<string, unknown> = { ...input };
  const repaired: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (typeof value !== 'string') continue;
    const first =
      markerRe(
        key,
        known.filter((k) => k !== key),
      ).exec(value) ??
      // `</self>` alone (the value's own closing tag) is also a marker
      (known.includes(key) ? new RegExp(`<\\/${escapeRe(key)}\\s*>`).exec(value) : null);
    if (!first) continue;
    const head = value.slice(0, first.index).replace(TRAILING_CLOSE, '').trimEnd();
    const tail = value.slice(first.index);
    const segs = segments(tail, known);
    // Only a real leak is repaired: the tail must open at least one other argument.
    const recovered = segs.filter(([k]) => k !== key);
    if (!recovered.length) {
      // a lone closing tag at the very end (`…text</summary>`) is still stripped
      if (/^\s*(<\/[A-Za-z_][A-Za-z0-9_]*\s*>\s*)+$/.test(tail)) out[key] = head;
      continue;
    }
    out[key] = head;
    for (const [name, raw] of recovered) {
      if (repaired.includes(name)) continue;
      const types = typesOf(schema, name);
      const provided = name in input && matchesType(input[name], types);
      if (provided) continue;
      out[name] = parseLoose(raw, types);
      repaired.push(name);
    }
  }
  return { input: out, repaired };
}

export type RepairedCall = ToolCallInput;

/**
 * A call to a tool named after a delegable role becomes a `delegate` call (same id). `delegable` is the role enum
 * of the agent's own `delegate` tool, so an agent without `delegate` is never normalised.
 */
export function normaliseRoleCall(
  call: ToolCallInput,
  delegable: readonly string[],
  hasTool: (name: string) => boolean,
): RepairedCall {
  if (hasTool(call.name) || !delegable.includes(call.name)) return call;
  const input = (call.input ?? {}) as Record<string, unknown>;
  const brief = typeof input.brief === 'string' ? input.brief : JSON.stringify(input);
  return {
    id: call.id,
    name: 'delegate',
    input: { role: call.name as AgentRole, brief },
    normalisedFrom: call.name,
  };
}

/** Both repairs, in order: leaked markup first (on the original args), then role-name normalisation. */
export function repairCall(
  call: ToolCallInput,
  delegable: readonly string[],
  hasTool: (name: string) => boolean,
  schemaOf?: (name: string) => ArgsSchemaView | undefined,
): RepairedCall {
  const { input, repaired } = repairLeakedParameters(
    (call.input ?? {}) as Record<string, unknown>,
    schemaOf?.(call.name),
  );
  const fixed = normaliseRoleCall({ ...call, input }, delegable, hasTool);
  return repaired.length ? { ...fixed, argsRepaired: repaired } : fixed;
}
