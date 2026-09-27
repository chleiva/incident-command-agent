/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Provider construction and the per-run router: retries (exponential backoff with jitter, ≤ 4 attempts) and the
 * switch to the fallback provider after TWO 5xx responses from the primary within a run (emits `llm.fallback`).
 */
import type {
  LlmConfig,
  LlmProvider,
  LlmRequest,
  LlmResponse,
  ProviderId,
  ProviderModel,
  SecretStore,
  WallClock,
} from '@ica/schema';
import { createAnthropicProvider } from './anthropic';
import { createBedrockProvider } from './bedrock';
import { is5xx, withRetry } from './errors';
import { createOpenAiProvider } from './openai';

export interface ProviderFactoryDeps {
  secrets?: SecretStore;
  providers?: Partial<Record<ProviderId, LlmProvider>>;
  fetch?: typeof fetch;
}

/** Resolve a provider: injected first (tests, replay), else built from secrets. Never logs keys. */
export async function createProvider(id: ProviderId, deps: ProviderFactoryDeps): Promise<LlmProvider> {
  const injected = deps.providers?.[id];
  if (injected) return injected;
  switch (id) {
    case 'anthropic': {
      const apiKey = await deps.secrets?.get('ANTHROPIC_API_KEY');
      if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not configured (SecretStore)');
      return createAnthropicProvider({ apiKey, fetch: deps.fetch });
    }
    case 'openai': {
      const apiKey = await deps.secrets?.get('OPENAI_API_KEY');
      if (!apiKey) throw new Error('OPENAI_API_KEY is not configured (SecretStore)');
      return createOpenAiProvider({ apiKey, fetch: deps.fetch });
    }
    case 'bedrock':
      return createBedrockProvider();
    case 'replay':
    case 'scripted':
      throw new Error(`provider '${id}' must be injected via RunDeps.providers`);
  }
}

export interface RouterOptions {
  config: LlmConfig;
  deps: ProviderFactoryDeps;
  clock: WallClock;
  rng?: () => number;
  /** Called once when the run switches to the fallback. */
  onFallback?: (from: ProviderModel, to: ProviderModel, reason: string) => Promise<void>;
  attempts?: number;
}

export interface RoutedResponse {
  response: LlmResponse;
  provider: ProviderId;
  model: string;
}

export class LlmRouter {
  private primary?: LlmProvider;
  private fallback?: LlmProvider;
  private primary5xx = 0;
  private switched = false;
  private switching?: Promise<void>;

  constructor(private readonly opts: RouterOptions) {}

  get active(): ProviderModel {
    const c = this.opts.config;
    return this.switched && c.fallback ? c.fallback : { provider: c.provider, model: c.model };
  }

  get usingFallback(): boolean {
    return this.switched;
  }

  private async providerFor(fallback: boolean): Promise<LlmProvider> {
    const c = this.opts.config;
    if (fallback) return (this.fallback ??= await createProvider(c.fallback!.provider, this.opts.deps));
    return (this.primary ??= await createProvider(c.provider, this.opts.deps));
  }

  private async switchToFallback(reason: string): Promise<void> {
    const c = this.opts.config;
    if (this.switched || !c.fallback) return;
    this.switched = true;
    this.switching = this.opts.onFallback?.({ provider: c.provider, model: c.model }, c.fallback, reason);
    await this.switching;
  }

  async complete(req: Omit<LlmRequest, 'model'>): Promise<RoutedResponse> {
    const attempt = async (fallback: boolean): Promise<RoutedResponse> => {
      const target = fallback ? this.opts.config.fallback! : this.opts.config;
      const provider = await this.providerFor(fallback);
      const response = await withRetry(() => provider.complete({ ...req, model: target.model }), {
        clock: this.opts.clock,
        rng: this.opts.rng,
        attempts: this.opts.attempts,
        signal: req.signal,
        onError: (err) => {
          if (!fallback && is5xx(err)) this.primary5xx++;
        },
        shouldStop: () => !fallback && this.primary5xx >= 2 && !!this.opts.config.fallback,
      });
      return { response, provider: target.provider as ProviderId, model: target.model };
    };
    if (this.switched) {
      await this.switching;
      return attempt(true);
    }
    try {
      return await attempt(false);
    } catch (err) {
      if (this.primary5xx >= 2 && this.opts.config.fallback) {
        await this.switchToFallback(
          `primary returned 5xx ${this.primary5xx} times: ${(err as Error).message}`,
        );
        return attempt(true);
      }
      throw err;
    }
  }
}
