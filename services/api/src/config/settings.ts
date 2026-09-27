/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** Settings shared by the router, the Lambda entries and the local dev server, parsed once from env. */
import {
  DEFAULT_RUN_LIMITS,
  PROVIDER_IDS,
  type AppConfig,
  type LlmConfig,
  type ProviderId,
} from '@ica/schema';
import { envBool, envNum, envOpt, envStr, type Env } from '../util/env';

export type AuthMode = 'none' | 'cognito';

export interface ApiSettings {
  /** 'none' is for the local dev server only; the Lambda entries refuse it. */
  authMode: AuthMode;
  /** Allowed CORS origins. '*' is only honoured with authMode 'none'. */
  corsOrigins: string[];
  maxRunsPerDay: number;
  /** Sim-time multiplier when `CreateRunRequest.speed` is omitted. */
  defaultSpeed: number;
  llm: LlmConfig;
  features: AppConfig['features'];
  /** Human name recorded on decisions when there is no JWT (AUTH_MODE=none). */
  localOperatorName: string;
}

export const SPEED_MIN = 1;
export const SPEED_MAX = 30;
export const DEFAULT_SPEED = 6;
/** 0 = no daily limit (the default: the product never stops on spend). */
export const DEFAULT_MAX_RUNS_PER_DAY = 0;
export const MAX_TEMPERATURE = 0.2;

function providerId(name: string, v: string): ProviderId {
  if (!(PROVIDER_IDS as readonly string[]).includes(v)) {
    throw new Error(`${name} must be one of ${PROVIDER_IDS.join(', ')} (got "${v}")`);
  }
  return v as ProviderId;
}

/** `LlmConfig` for the runtime from the documented env variables (.env.example). */
export function llmConfigFromEnv(env: Env): LlmConfig {
  const provider = providerId('LLM_PROVIDER', envStr(env, 'LLM_PROVIDER', 'anthropic'));
  const model = envStr(env, 'LLM_MODEL', 'claude-sonnet-5');
  const temperature = envNum(env, 'LLM_TEMPERATURE', MAX_TEMPERATURE);
  if (temperature < 0 || temperature > MAX_TEMPERATURE) {
    throw new Error(`LLM_TEMPERATURE must be between 0 and ${MAX_TEMPERATURE} (NFR-03)`);
  }
  const fbProvider = envOpt(env, 'LLM_FALLBACK_PROVIDER');
  const fbModel = envOpt(env, 'LLM_FALLBACK_MODEL');
  const cfg: LlmConfig = {
    provider,
    model,
    temperature,
    maxTokens: envNum(env, 'LLM_MAX_TOKENS', 4096),
    limits: {
      ...DEFAULT_RUN_LIMITS,
      budgetUsd: envNum(env, 'RUN_BUDGET_USD', DEFAULT_RUN_LIMITS.budgetUsd),
      horizonMin: envNum(env, 'RUN_HORIZON_MIN', DEFAULT_RUN_LIMITS.horizonMin),
    },
  };
  if (fbProvider && fbModel) {
    cfg.fallback = { provider: providerId('LLM_FALLBACK_PROVIDER', fbProvider), model: fbModel };
  }
  return cfg;
}

export function settingsFromEnv(env: Env): ApiSettings {
  const authMode = envStr(env, 'AUTH_MODE', 'cognito') as AuthMode;
  if (authMode !== 'none' && authMode !== 'cognito') throw new Error('AUTH_MODE must be none or cognito');
  const corsOrigins = envStr(env, 'CORS_ORIGINS', authMode === 'none' ? '*' : '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    authMode,
    corsOrigins,
    maxRunsPerDay: envNum(env, 'MAX_RUNS_PER_DAY', DEFAULT_MAX_RUNS_PER_DAY),
    defaultSpeed: envNum(env, 'DEFAULT_SPEED', DEFAULT_SPEED),
    llm: llmConfigFromEnv(env),
    features: {
      webSearch: envBool(env, 'FEATURE_WEB_SEARCH'),
      liveWeather: envBool(env, 'FEATURE_LIVE_WEATHER'),
      narrator: envBool(env, 'FEATURE_NARRATOR'),
      sideBySide: envBool(env, 'FEATURE_SIDE_BY_SIDE', true),
    },
    localOperatorName: envStr(env, 'LOCAL_OPERATOR_NAME', 'Local Operator'),
  };
}
