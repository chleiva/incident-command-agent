/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** Tool test helpers: validate args like the runtime does (Ajv, strict), then call the handler via the harness. */
import { compileSchema, type ToolContext, type ToolOutcome } from '@ica/schema';
import { FIXTURE_INDEX_DIR, loadKnowledgeIndex } from '../knowledge/index';
import { harness, type Harness } from '../systems/testing';
import { toolByName } from './index';

export async function fixtureHarness(scenario?: Parameters<typeof harness>[0]): Promise<Harness> {
  const knowledge = await loadKnowledgeIndex({ source: 'fs', path: FIXTURE_INDEX_DIR, embeddings: 'none' });
  return harness(scenario, knowledge);
}

const validators = new Map<string, (x: unknown) => { ok: boolean; errors?: string[] }>();

export function argsValid(name: string, input: unknown): { ok: boolean; errors?: string[] } {
  const tool = toolByName[name];
  if (!tool) throw new Error(`unknown tool ${name}`);
  let v = validators.get(name);
  if (!v) validators.set(name, (v = compileSchema(tool.inputSchema as never) as never));
  return v!(input);
}

let requestCounter = 0;

/**
 * Like a client, add a fresh `requestId` to calls of idempotent tools that do not carry one (tests that are not
 * about idempotency). Pass `requestId` explicitly to test retries.
 */
export function withClientRequestId(name: string, input: unknown): unknown {
  const tool = toolByName[name];
  if (tool?.idempotencyKey !== '/requestId' || !input || typeof input !== 'object') return input;
  if (typeof (input as Record<string, unknown>).requestId === 'string') return input;
  return { ...(input as Record<string, unknown>), requestId: `test-req-${++requestCounter}` };
}

/** Validate args (throws on schema failure) and call the tool. */
export async function call<O = any>(
  h: Harness,
  name: string,
  rawInput: unknown,
  extra: Partial<ToolContext> = {},
): Promise<ToolOutcome<O>> {
  const input = withClientRequestId(name, rawInput);
  const r = argsValid(name, input);
  if (!r.ok) throw new Error(`${name} args invalid: ${(r.errors ?? []).join('; ')}`);
  return h.call<O>(toolByName[name], input, extra);
}

export function okData<O>(out: ToolOutcome<O>): O {
  if (!out.ok) throw new Error(`expected ok, got error: ${out.error}`);
  return out.data;
}
