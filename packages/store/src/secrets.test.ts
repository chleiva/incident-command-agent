/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import { EnvSecretStore, envHydratedSecretNames, hydrateEnvFromSecrets, lambdaSecretIds } from './secrets';

describe('lambda secret env helpers', () => {
  it('reads the ApiStack ARNs, falling back to the DataStack names', () => {
    expect(lambdaSecretIds({ LLM_SECRET_ARN: 'arn:llm', SEARCH_SECRET_ARN: 'arn:search' })).toEqual([
      'arn:llm',
      'arn:search',
    ]);
    expect(lambdaSecretIds({ LLM_SECRET_ARN: 'arn:llm' })).toEqual(['arn:llm']);
    expect(lambdaSecretIds({})).toEqual(['ica/llm', 'ica/search']);
  });

  it('hydrates missing env keys from the secret store without overriding set ones', async () => {
    const env: Record<string, string | undefined> = { BRAVE_API_KEY: 'keep' };
    const secrets = new EnvSecretStore({ TAVILY_API_KEY: 't-key', BRAVE_API_KEY: 'other' });
    expect(await hydrateEnvFromSecrets(secrets, ['TAVILY_API_KEY', 'BRAVE_API_KEY'], env)).toEqual([
      'TAVILY_API_KEY',
    ]);
    expect(env).toEqual({ BRAVE_API_KEY: 'keep', TAVILY_API_KEY: 't-key' });
  });

  it('names the env-read secrets for the configuration', () => {
    expect(envHydratedSecretNames({})).toEqual([]);
    expect(envHydratedSecretNames({ FEATURE_WEB_SEARCH: 'true', KB_EMBEDDINGS: 'openai' })).toEqual([
      'TAVILY_API_KEY',
      'BRAVE_API_KEY',
      'OPENAI_API_KEY',
    ]);
  });
});
