/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** SecretStore implementations. Never log secret values. */
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { SecretStore } from '@ica/schema';
import { isTransientError, withRetry, type RetryOptions } from './retry';

/** Local: reads `process.env` (populated from `.env` by the dev server). */
export class EnvSecretStore implements SecretStore {
  constructor(private readonly env: Record<string, string | undefined> = process.env) {}
  async get(name: string): Promise<string | undefined> {
    const v = this.env[name];
    return v === undefined || v === '' ? undefined : v;
  }
}

export interface SecretsManagerSecretStoreOptions {
  /**
   * Secret ids/ARNs whose SecretString is a JSON object of name → value, e.g. `ica/llm` =
   * `{"ANTHROPIC_API_KEY":"…","OPENAI_API_KEY":"…"}` and `ica/search`. Searched in order.
   */
  secretIds: string[];
  client?: SecretsManagerClient;
  region?: string;
  /** Transient-error retry policy (default: 5 attempts, full jitter, cap 8 s). */
  retry?: RetryOptions;
}

/**
 * AWS: Secrets Manager, cached for the lifetime of the Lambda container (each secret fetched at most once).
 * A secret that is missing or not JSON is treated as empty (so optional secrets like `ica/search` may be absent).
 */
export class SecretsManagerSecretStore implements SecretStore {
  private readonly client: SecretsManagerClient;
  private cache: Promise<Record<string, string>> | null = null;

  constructor(private readonly opts: SecretsManagerSecretStoreOptions) {
    this.client = opts.client ?? new SecretsManagerClient({ region: opts.region });
  }

  private transientFailure = false;

  private async loadOne(secretId: string): Promise<Record<string, string>> {
    try {
      const res = await withRetry(
        () => this.client.send(new GetSecretValueCommand({ SecretId: secretId })),
        this.opts.retry,
      );
      const parsed: unknown = JSON.parse(res.SecretString ?? '{}');
      if (!parsed || typeof parsed !== 'object') return {};
      return Object.fromEntries(
        Object.entries(parsed as Record<string, unknown>).filter(
          ([, v]) => typeof v === 'string' && v !== '',
        ),
      ) as Record<string, string>;
    } catch (err) {
      const name = (err as { name?: string }).name ?? 'Error';
      // A transient failure (after retries) is not cached: the next get() tries again.
      if (isTransientError(err)) this.transientFailure = true;
      console.warn(JSON.stringify({ msg: 'secret unavailable', secretId, error: name }));
      return {};
    }
  }

  private load(): Promise<Record<string, string>> {
    this.cache ??= Promise.all(this.opts.secretIds.map((id) => this.loadOne(id))).then((maps) => {
      if (this.transientFailure) {
        this.transientFailure = false;
        this.cache = null;
      }
      return Object.assign({}, ...[...maps].reverse()) as Record<string, string>;
    });
    return this.cache;
  }

  async get(name: string): Promise<string | undefined> {
    return (await this.load())[name];
  }
}

/** Default Secrets Manager names created by the DataStack (used when the ARNs are not in the environment). */
export const DEFAULT_SECRET_IDS = ['ica/llm', 'ica/search'] as const;

/**
 * The secret ids a Lambda reads, in lookup order. Single source of truth for the env names the ApiStack sets:
 * `LLM_SECRET_ARN` (`{ANTHROPIC_API_KEY, OPENAI_API_KEY}`) and `SEARCH_SECRET_ARN` (`{TAVILY_API_KEY, BRAVE_API_KEY}`).
 * Falls back to the DataStack secret names when neither is set.
 */
export function lambdaSecretIds(env: Record<string, string | undefined> = process.env): string[] {
  const ids = [env.LLM_SECRET_ARN, env.SEARCH_SECRET_ARN]
    .map((s) => s?.trim())
    .filter((s): s is string => !!s);
  return ids.length ? ids : [...DEFAULT_SECRET_IDS];
}

/** Keys that tools read from `process.env` (web search) rather than from the SecretStore. */
export const ENV_HYDRATED_SECRETS = ['TAVILY_API_KEY', 'BRAVE_API_KEY'] as const;

/**
 * The secrets env-reading code needs for this configuration: the web-search keys when `FEATURE_WEB_SEARCH=true`,
 * and `OPENAI_API_KEY` when the knowledge query embedder is `KB_EMBEDDINGS=openai`.
 */
export function envHydratedSecretNames(env: Record<string, string | undefined> = process.env): string[] {
  const names: string[] = [];
  if (env.FEATURE_WEB_SEARCH === 'true') names.push(...ENV_HYDRATED_SECRETS);
  if (env.KB_EMBEDDINGS?.toLowerCase() === 'openai') names.push('OPENAI_API_KEY');
  return names;
}

/**
 * Copy the named secrets into `env` when they are not already set (so env-reading code such as `web_search` sees
 * the Secrets Manager values on Lambda). Returns the names that were set. Never logs values.
 */
export async function hydrateEnvFromSecrets(
  secrets: SecretStore,
  names: readonly string[] = ENV_HYDRATED_SECRETS,
  env: Record<string, string | undefined> = process.env,
): Promise<string[]> {
  const set: string[] = [];
  for (const name of names) {
    if (env[name]) continue;
    const v = await secrets.get(name);
    if (v) {
      env[name] = v;
      set.push(name);
    }
  }
  return set;
}
