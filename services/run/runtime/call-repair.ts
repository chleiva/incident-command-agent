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
 *   (`"…</parameter>\n<parameter name=\"actionsTaken\">[…]"`) is split back into its keys (live run 1: the
 *   maintenance report "missed" actionsTaken four times because it was inside `summary`).
 */
import type { AgentRole } from '@ica/schema';
import type { ToolCallInput } from './execute';

/** `</parameter>` followed by the next `<parameter name="key">` opening tag. */
const LEAK_SPLIT = /\s*<\/parameter>\s*<parameter name=\\?"([A-Za-z_][A-Za-z0-9_]*)\\?">\s*/;
const LEAK_SPLIT_ALL = new RegExp(LEAK_SPLIT.source, 'g');
const TRAILING_CLOSE = /\s*<\/parameter>\s*(<\/invoke>\s*)?$/;

function parseLoose(raw: string): unknown {
  const t = raw.trim();
  if (!t) return t;
  if (/^[[{"]|^-?\d|^(true|false|null)$/.test(t)) {
    try {
      return JSON.parse(t);
    } catch {
      /* not JSON: keep the string */
    }
  }
  return t;
}

/**
 * Recover arguments the model leaked into a string value as tool-call markup. Only top-level string values are
 * inspected; a recovered key never overwrites a key the model sent properly.
 */
export function repairLeakedParameters(input: Record<string, unknown>): {
  input: Record<string, unknown>;
  repaired: string[];
} {
  const leaking = Object.entries(input).filter(([, v]) => typeof v === 'string' && LEAK_SPLIT.test(v));
  if (!leaking.length) return { input, repaired: [] };
  const out: Record<string, unknown> = { ...input };
  const repaired: string[] = [];
  for (const [key, value] of leaking) {
    const parts = (value as string).split(LEAK_SPLIT_ALL);
    out[key] = parts[0]!.replace(TRAILING_CLOSE, '').trimEnd();
    for (let i = 1; i + 1 < parts.length; i += 2) {
      const name = parts[i]!;
      if (name in input || repaired.includes(name)) continue;
      out[name] = parseLoose(parts[i + 1]!.replace(TRAILING_CLOSE, ''));
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
): RepairedCall {
  const { input, repaired } = repairLeakedParameters((call.input ?? {}) as Record<string, unknown>);
  const fixed = normaliseRoleCall({ ...call, input }, delegable, hasTool);
  return repaired.length ? { ...fixed, argsRepaired: repaired } : fixed;
}
