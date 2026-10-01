/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** LLM configuration from the environment (`.env.example` is authoritative). */
import {
  DEFAULT_RUN_LIMITS,
  PROVIDER_IDS,
  type LlmConfig,
  type ProviderId,
  type RunLimits,
} from '@ica/schema';

export const MAX_TEMPERATURE = 0.2;
export const DEFAULT_MODEL = 'claude-sonnet-5-5';
export const DEFAULT_MAX_TOKENS = 4096;

type Env = Record<string, string | undefined>;

function num(v: string | undefined, fallback: number, name: string): number {
  if (v === undefined || v.trim() === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative number, got '${v}'`);
  return n;
}

function providerId(v: string | undefined, fallback: ProviderId, name: string): ProviderId {
  const p = (v?.trim() || fallback) as ProviderId;
  if (!(PROVIDER_IDS as readonly string[]).includes(p)) throw new Error(`${name}: unknown provider '${p}'`);
  return p;
}

/** Reject temperatures above 0.2 (NFR-03: deterministic-enough runs). */
export function assertTemperature(t: number): number {
  if (!(t >= 0 && t <= MAX_TEMPERATURE)) {
    throw new Error(`LLM_TEMPERATURE must be between 0 and ${MAX_TEMPERATURE} (NFR-03), got ${t}`);
  }
  return t;
}

export function runLimitsFromEnv(env: Env = process.env, base: RunLimits = DEFAULT_RUN_LIMITS): RunLimits {
  return {
    ...base,
    budgetUsd: num(env.RUN_BUDGET_USD, base.budgetUsd, 'RUN_BUDGET_USD'),
    horizonMin: Math.max(1, num(env.RUN_HORIZON_MIN, base.horizonMin, 'RUN_HORIZON_MIN')),
  };
}

export function llmConfigFromEnv(env: Env = process.env, overrides: Partial<LlmConfig> = {}): LlmConfig {
  const provider = providerId(env.LLM_PROVIDER, 'anthropic', 'LLM_PROVIDER');
  const cfg: LlmConfig = {
    provider,
    model: env.LLM_MODEL?.trim() || DEFAULT_MODEL,
    temperature: assertTemperature(num(env.LLM_TEMPERATURE, MAX_TEMPERATURE, 'LLM_TEMPERATURE')),
    maxTokens:
      Math.floor(num(env.LLM_MAX_TOKENS, DEFAULT_MAX_TOKENS, 'LLM_MAX_TOKENS')) || DEFAULT_MAX_TOKENS,
    limits: runLimitsFromEnv(env),
  };
  if (env.LLM_FALLBACK_PROVIDER?.trim() && env.LLM_FALLBACK_MODEL?.trim()) {
    cfg.fallback = {
      provider: providerId(env.LLM_FALLBACK_PROVIDER, 'anthropic', 'LLM_FALLBACK_PROVIDER'),
      model: env.LLM_FALLBACK_MODEL.trim(),
    };
  }
  const merged = { ...cfg, ...overrides, limits: { ...cfg.limits, ...overrides.limits } };
  assertTemperature(merged.temperature);
  return merged;
}
