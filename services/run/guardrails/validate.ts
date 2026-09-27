/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** Tool-argument validation (JSON Schema, Ajv) and reference validation (ids must exist in the run). */
import { compileSchema, type JSONSchema, type RefKind, type ToolDefinition } from '@ica/schema';
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

export function validateToolArgs(tool: Pick<ToolDefinition, 'inputSchema'>, args: unknown): ArgCheck {
  return validateAgainst(tool.inputSchema, args);
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
