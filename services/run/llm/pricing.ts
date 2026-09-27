/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Token pricing from `config/pricing.json` (USD per million tokens). Used for `usage.costUsd` on every event that
 * consumed tokens, for the per-run `RUN_BUDGET_USD` hard stop and by the eval budget guard.
 */
import type { LlmUsage, ProviderId, Usage } from '@ica/schema';
import pricingJson from '../../../config/pricing.json' with { type: 'json' };

export interface ModelPrice {
  provider: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  status?: string;
}

export interface PricingTable {
  gbpUsdRate: number;
  verifiedOn: string;
  models: Record<string, ModelPrice>;
  defaults: Record<string, string>;
}

export const PRICING: PricingTable = pricingJson as unknown as PricingTable;

/** Price used for a model that is not in the table: the most expensive known model (conservative). */
function fallbackPrice(table: PricingTable): ModelPrice {
  const all = Object.values(table.models);
  return {
    provider: 'unknown',
    input: Math.max(...all.map((m) => m.input)),
    output: Math.max(...all.map((m) => m.output)),
    cacheRead: Math.max(...all.map((m) => m.cacheRead)),
    cacheWrite: Math.max(...all.map((m) => m.cacheWrite)),
    status: 'unknown-model',
  };
}

export function priceFor(model: string, table: PricingTable = PRICING): ModelPrice {
  return table.models[model] ?? fallbackPrice(table);
}

/** USD cost of one call. `inputTokens` are the uncached input tokens (Anthropic semantics). */
export function costUsd(model: string, u: LlmUsage, table: PricingTable = PRICING): number {
  const p = priceFor(model, table);
  const usd =
    (u.inputTokens * p.input +
      u.outputTokens * p.output +
      u.cacheReadTokens * p.cacheRead +
      u.cacheWriteTokens * p.cacheWrite) /
    1e6;
  return Math.round(usd * 1e8) / 1e8;
}

/** Worst-case USD for a call with `inputTokens` of prompt (priced as cache writes) and `outputTokens` out. */
export function worstCaseUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
  table: PricingTable = PRICING,
): number {
  const p = priceFor(model, table);
  return (inputTokens * Math.max(p.input, p.cacheWrite) + outputTokens * p.output) / 1e6;
}

/** Build the event `usage` field. */
export function toEventUsage(
  provider: ProviderId,
  model: string,
  u: LlmUsage,
  table: PricingTable = PRICING,
): Usage {
  return {
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    cacheReadTokens: u.cacheReadTokens,
    cacheWriteTokens: u.cacheWriteTokens,
    costUsd: costUsd(model, u, table),
    model,
    provider,
  };
}

/** Total prompt tokens of a call (uncached + cache reads + cache writes): what the per-run token limit counts. */
export function totalInputTokens(u: LlmUsage): number {
  return u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens;
}
