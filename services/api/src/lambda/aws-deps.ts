/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * AWS wiring shared by the Lambda entries: DynamoStore + S3TraceStore + Secrets Manager, created once per container.
 * Env (set by infra/ApiStack): TABLE_NAME, TRACES_BUCKET, KNOWLEDGE_BUCKET, LLM_SECRET_ARN, SEARCH_SECRET_ARN
 * (secret ids via `lambdaSecretIds` from @ica/store, the index path via `knowledgeS3PathFromEnv` from @ica/run).
 */
import type { KnowledgeIndex, RunDeps } from '@ica/schema';
import {
  DynamoStore,
  S3TraceStore,
  SecretsManagerSecretStore,
  envHydratedSecretNames,
  hydrateEnvFromSecrets,
  lambdaSecretIds,
} from '@ica/store';
import { llmConfigFromEnv } from '../config/settings';
import { envRequired, type Env } from '../util/env';

export interface AwsCore {
  store: DynamoStore;
  traces: S3TraceStore;
}

let core: AwsCore | null = null;

export function awsCore(env: Env = process.env): AwsCore {
  if (!core) {
    const traces = new S3TraceStore({ bucket: envRequired(env, 'TRACES_BUCKET') });
    core = { traces, store: new DynamoStore({ tableName: envRequired(env, 'TABLE_NAME'), traces }) };
  }
  return core;
}

export function awsSecrets(env: Env = process.env): SecretsManagerSecretStore {
  return new SecretsManagerSecretStore({ secretIds: lambdaSecretIds(env) });
}

/** RunDeps for Lambda-side runtime calls (author Lambda). The knowledge index is loaded once per container. */
export function createAwsRunDeps(
  loadKnowledge: () => Promise<KnowledgeIndex>,
  env: Env = process.env,
): () => Promise<RunDeps> {
  let cached: Promise<RunDeps> | null = null;
  return () => {
    cached ??= (async () => {
      const { store, traces } = awsCore(env);
      const secrets = awsSecrets(env);
      // web_search and the openai query embedder read their keys from process.env.
      await hydrateEnvFromSecrets(secrets, envHydratedSecretNames(env));
      return {
        store,
        traces,
        knowledge: await loadKnowledge(),
        llm: llmConfigFromEnv(env),
        secrets,
      };
    })();
    cached.catch(() => {
      cached = null;
    });
    return cached;
  };
}
