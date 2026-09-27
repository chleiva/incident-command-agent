/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** Tool-argument validation (JSON Schema, Ajv) and reference validation (ids must exist in the run). */
import { compileSchema, createAjv, type JSONSchema, type RefKind, type ToolDefinition } from '@ica/schema';
import { getPointer } from './screen-output';

export type ArgCheck = { ok: true } | { ok: false; errors: string[] };

const validators = new WeakMap<object, (x: unknown) => ArgCheck>();

/** Validate `args` against a JSON schema (compiled once per schema object, with the shared Ajv settings). */
export function validateAgainst(schema: JSONSchema, args: unknown): ArgCheck {
  let fn = validators.get(schema);
  if (!fn) {
    try {
      const v = compileSchema(schema as never);
      fn = (x) => {
        const r = v(x);
        return r.ok ? { ok: true } : { ok: false, errors: r.errors };
      };
    } catch (err) {
      const msg = `tool schema does not compile: ${(err as Error).message}`;
      fn = () => ({ ok: false, errors: [msg] });
    }
    validators.set(schema, fn);
  }
  return fn(args);
}

const ajv = createAjv();
type RawValidate = ReturnType<typeof ajv.compile>;
type RawError = NonNullable<RawValidate['errors']>[number];
const rawValidators = new WeakMap<object, RawValidate | string>();

/** Keep a list readable: at most `n` items, then "+k more". */
function list(items: string[], n = 12): string {
  return items.length > n ? `${items.slice(0, n).join(', ')} (+${items.length - n} more)` : items.join(', ');
}

/**
 * Concise, model-actionable argument errors (Ajv `allErrors`): the keys received, the required keys missing, the
 * unexpected keys, then one line per field error. Nested paths are JSON pointers (`/options/0/label`).
 */
export function describeArgErrors(errors: readonly RawError[], args: unknown): string[] {
  const missing = new Map<string, string[]>();
  const unexpected = new Map<string, string[]>();
  const fields: string[] = [];
  const push = (m: Map<string, string[]>, at: string, key: string) => {
    const cur = m.get(at) ?? [];
    if (!cur.includes(key)) cur.push(key);
    m.set(at, cur);
  };
  for (const e of errors) {
    const at = e.instancePath || '';
    if (e.keyword === 'required') {
      push(missing, at, String((e.params as { missingProperty?: string }).missingProperty));
    } else if (e.keyword === 'additionalProperties') {
      push(unexpected, at, String((e.params as { additionalProperty?: string }).additionalProperty));
    } else if (e.keyword === 'anyOf' || e.keyword === 'oneOf' || e.keyword === 'if') {
      // The branch errors say more; keep the summary line only when nothing else points at this path.
      if (!errors.some((x) => x !== e && x.instancePath === e.instancePath && x.keyword !== e.keyword))
        fields.push(`${at || '/'}: ${e.message ?? e.keyword}`);
    } else {
      const extra =
        e.keyword === 'enum' || e.keyword === 'const'
          ? ` (${JSON.stringify((e.params as { allowedValues?: unknown; allowedValue?: unknown }).allowedValues ?? (e.params as { allowedValue?: unknown }).allowedValue)})`
          : '';
      fields.push(`${at || '/'}: ${e.message ?? e.keyword}${extra}`);
    }
  }
  const out: string[] = [];
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    const keys = Object.keys(args);
    out.push(`received keys: ${keys.length ? list(keys) : '(none)'}`);
  } else {
    out.push(`received ${Array.isArray(args) ? 'an array' : typeof args}, expected an object`);
  }
  for (const [at, keys] of missing) out.push(`${at ? `${at}: ` : ''}missing required: ${list(keys)}`);
  for (const [at, keys] of unexpected)
    out.push(`${at ? `${at}: ` : ''}unexpected keys (not allowed): ${list(keys)}`);
  out.push(...[...new Set(fields)].slice(0, 12));
  return out;
}

function rawValidator(tool: Pick<ToolDefinition, 'inputSchema'>): RawValidate | string {
  const schema = tool.inputSchema as object;
  let fn = rawValidators.get(schema);
  if (!fn) {
    try {
      fn = ajv.compile(JSON.parse(JSON.stringify(schema)) as object);
    } catch (err) {
      fn = `tool schema does not compile: ${(err as Error).message}`;
    }
    rawValidators.set(schema, fn);
  }
  return fn;
}

/** Validate tool arguments against the tool's input schema, with concise errors (see `describeArgErrors`). */
export function validateToolArgs(tool: Pick<ToolDefinition, 'inputSchema'>, args: unknown): ArgCheck {
  const fn = rawValidator(tool);
  if (typeof fn === 'string') return { ok: false, errors: [fn] };
  return fn(args) ? { ok: true } : { ok: false, errors: describeArgErrors(fn.errors ?? [], args) };
}

// ---------------------------------------------------------------- length leniency (live run 2)

/** Appended to a free-text value the runtime truncated at its schema cap. */
export const TRUNCATION_SUFFIX = ' …[truncated]';
/** Below this cap the truncation marker is the bare ellipsis (the full suffix would not fit). */
export const SHORT_TRUNCATION_SUFFIX = '…';
const FULL_SUFFIX_MIN_CAP = 40;

export interface LenientArgs {
  args: Record<string, unknown>;
  /** JSON pointers truncated at their cap. */
  truncated: string[];
  /** JSON pointers passed through uncut because the tool splits them (`ToolDefinition.splitOverlong`). */
  split: string[];
}

function schemaAt(schema: unknown, schemaPath: string): Record<string, unknown> | undefined {
  // "#/properties/text/maxLength" → the node holding maxLength
  const parts = schemaPath.replace(/^#\/?/, '').split('/').slice(0, -1);
  let cur: unknown = schema;
  for (const raw of parts) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur && typeof cur === 'object' ? (cur as Record<string, unknown>) : undefined;
}

/**
 * Free text = a string field with a length cap and no pattern / enum / const / format (demo review 2: whatever the
 * cap; ids, codes and request ids all carry a pattern, so they are never truncated).
 */
export function isFreeText(node: Record<string, unknown> | undefined): boolean {
  return (
    !!node &&
    node.type === 'string' &&
    typeof node.maxLength === 'number' &&
    node.maxLength > 0 &&
    node.pattern === undefined &&
    node.enum === undefined &&
    node.const === undefined &&
    node.format === undefined
  );
}

function setPointer(obj: unknown, pointer: string, value: unknown): void {
  const keys = pointer
    .replace(/^\//, '')
    .split('/')
    .map((k) => k.replace(/~1/g, '/').replace(/~0/g, '~'));
  let cur = obj as Record<string, unknown>;
  for (const k of keys.slice(0, -1)) cur = cur[k] as Record<string, unknown>;
  cur[keys.at(-1)!] = value;
}

/** Cut `text` so that it plus the suffix fits in `cap`. */
export function truncateAtCap(text: string, cap: number): string {
  const suffix = cap >= FULL_SUFFIX_MIN_CAP ? TRUNCATION_SUFFIX : SHORT_TRUNCATION_SUFFIX;
  return `${text.slice(0, Math.max(0, cap - suffix.length)).trimEnd()}${suffix}`;
}

/**
 * Length leniency: when the ONLY validation errors are `maxLength` on free-text string fields (`isFreeText`: type
 * string, any cap, no pattern/enum/const/format), return the args with those values truncated at the cap (or, for the tool's
 * `splitOverlong` fields, passed through uncut) instead of rejecting the call. Returns null when the args are valid
 * or when any other error remains (the call is then rejected as before).
 */
export function lenientArgs(
  tool: Pick<ToolDefinition, 'inputSchema' | 'splitOverlong'>,
  args: Record<string, unknown>,
): LenientArgs | null {
  const fn = rawValidator(tool);
  if (typeof fn === 'string' || fn(args)) return null;
  const errors = [...(fn.errors ?? [])];
  if (!errors.length || errors.some((e) => e.keyword !== 'maxLength')) return null;
  const out = JSON.parse(JSON.stringify(args)) as Record<string, unknown>;
  const check = JSON.parse(JSON.stringify(args)) as Record<string, unknown>;
  const truncated: string[] = [];
  const split: string[] = [];
  for (const e of errors) {
    const node = schemaAt(tool.inputSchema, e.schemaPath);
    if (!isFreeText(node) || !e.instancePath) return null;
    const cap = (e.params as { limit: number }).limit;
    const value = getPointer(args, e.instancePath);
    if (typeof value !== 'string') return null;
    setPointer(check, e.instancePath, truncateAtCap(value, cap));
    if (tool.splitOverlong?.includes(e.instancePath)) {
      split.push(e.instancePath);
    } else {
      setPointer(out, e.instancePath, truncateAtCap(value, cap));
      truncated.push(e.instancePath);
    }
  }
  // Everything else must now validate (with split fields checked at their cap).
  if (!fn(check)) return null;
  return { args: out, truncated, split };
}

export type KnownRefs = Partial<Record<RefKind, Set<string>>>;

/**
 * Every value at each `tool.refs[].path` must be a known id of that kind. Missing (optional) values are skipped, and
 * so are kinds no system reports (nothing to validate against).
 */
export function validateRefs(tool: Pick<ToolDefinition, 'refs'>, args: unknown, known: KnownRefs): ArgCheck {
  const errors: string[] = [];
  for (const ref of tool.refs ?? []) {
    const set = known[ref.kind];
    if (!set) continue;
    const v = getPointer(args, ref.path);
    if (v === undefined || v === null) continue;
    const values = Array.isArray(v) ? v : [v];
    for (const x of values) {
      if (typeof x !== 'string' || !set.has(x)) {
        errors.push(`${ref.path}: unknown ${ref.kind} '${String(x)}'`);
      }
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true };
}
