/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Run Lambda entry point: CDK (task 04, `infra/src/stacks/api-stack.ts`) points the Run Lambda at `handler`. The
 * author Lambda is `services/api/src/lambda/author.ts` (it calls `runAuthor` from '@ica/run').
 *
 * Environment (set by the ApiStack; names shared with the author Lambda via @ica/store / @ica/run helpers):
 * - `TABLE_NAME` (DynamoDB single table), `TRACES_BUCKET` (S3 traces), `AWS_REGION`
 * - `KNOWLEDGE_BUCKET`: the knowledge index at `s3://$KNOWLEDGE_BUCKET/index`, loaded ONCE per container
 * - `LLM_SECRET_ARN`, `SEARCH_SECRET_ARN`: Secrets Manager JSON secrets holding provider / search keys
 *   (default `ica/llm`, `ica/search`); search keys are copied into `process.env` for `web_search`
 * - `KB_EMBEDDINGS`, `KB_VECTOR_STORE`/`KB_VECTOR_BUCKET`/`KB_VECTOR_INDEX`, `KB_EMBED_MODEL`/`KB_EMBED_DIMS`/
 *   `KB_EMBED_REGION`, `KB_RERANK`/`KB_RERANK_MODEL`/`KB_RERANK_REGION`: hybrid retrieval (BM25 + Cohere Embed v4 →
 *   S3 Vectors → Cohere Rerank 3.5), see services/run/knowledge/index.ts and docs/deploy.md
 * - `LLM_*`, `RUN_BUDGET_USD`, `RUN_HORIZON_MIN` (see .env.example)
 */
import type { KnowledgeIndex, RunDeps, SecretStore, Store, TraceStore } from '@ica/schema';
import {
  DynamoStore,
  S3TraceStore,
  SecretsManagerSecretStore,
  envHydratedSecretNames,
  hydrateEnvFromSecrets,
  lambdaSecretIds,
} from '@ica/store';
import { executeRun } from './index';
import { knowledgeS3PathFromEnv, loadKnowledgeIndex } from './knowledge/index';
import { llmConfigFromEnv } from './llm/config';
import type { RunResult } from './runtime/run';

/** Minimal Lambda context shape (avoids a dependency on @types/aws-lambda). */
export interface LambdaContextLike {
  getRemainingTimeInMillis(): number;
  awsRequestId?: string;
}

/** Async invocation payload from the API: `{ runId }`. */
export interface RunInvocation {
  runId: string;
}

/** Stop gracefully when less than this much Lambda time remains. */
export const STOP_MARGIN_MS = 60_000;

export interface HandlerDeps {
  store: Store;
  traces: TraceStore;
  secrets: SecretStore;
  knowledge: () => Promise<KnowledgeIndex>;
  env?: Record<string, string | undefined>;
  /** Poll interval for the remaining-time guard (ms). */
  guardIntervalMs?: number;
}

let containerDeps: HandlerDeps | undefined;
let knowledgeOnce: Promise<KnowledgeIndex> | undefined;

function defaultDeps(): HandlerDeps {
  const env = process.env;
  if (!env.TABLE_NAME) throw new Error('TABLE_NAME is not set');
  const traces = new S3TraceStore({ bucket: env.TRACES_BUCKET ?? '', region: env.AWS_REGION });
  return {
    store: new DynamoStore({ tableName: env.TABLE_NAME, region: env.AWS_REGION, traces }),
    traces,
    secrets: new SecretsManagerSecretStore({
      secretIds: lambdaSecretIds(env),
      region: env.AWS_REGION,
    }),
    // Loaded once per container (cold start), then reused by every invocation.
    knowledge: () =>
      (knowledgeOnce ??= loadKnowledgeIndex({
        source: 's3',
        path: knowledgeS3PathFromEnv(env),
      })),
  };
}

/** Build a run handler over injected dependencies (tests use MemoryStore). */
export function createRunHandler(getDeps: () => HandlerDeps) {
  return async (event: RunInvocation, context?: LambdaContextLike): Promise<RunResult> => {
    if (!event?.runId) throw new Error('invalid invocation: { runId } required');
    const d = getDeps();
    const env = d.env ?? process.env;
    // web_search and the openai query embedder read their keys from process.env.
    await hydrateEnvFromSecrets(d.secrets, envHydratedSecretNames(env));
    const deps: RunDeps = {
      store: d.store,
      traces: d.traces,
      secrets: d.secrets,
      knowledge: await d.knowledge(),
      llm: llmConfigFromEnv(env),
      approvalsPolicy: 'human',
    };
    const ac = new AbortController();
    const timer = context
      ? setInterval(() => {
          if (context.getRemainingTimeInMillis() < STOP_MARGIN_MS) ac.abort();
        }, d.guardIntervalMs ?? 1_000)
      : undefined;
    if (context && context.getRemainingTimeInMillis() < STOP_MARGIN_MS) ac.abort();
    try {
      const result = await executeRun({ runId: event.runId, deps, signal: ac.signal });
      console.log(
        JSON.stringify({
          msg: 'run finished',
          runId: event.runId,
          status: result.status,
          reason: result.reason,
        }),
      );
      return result;
    } finally {
      if (timer) clearInterval(timer);
    }
  };
}

export const handler = createRunHandler(() => (containerDeps ??= defaultDeps()));
