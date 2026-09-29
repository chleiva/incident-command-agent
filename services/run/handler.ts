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
 * - `SIM_AUTO_APPROVE_AFTER_MS`: the simulation safety net for agent runs (default 0 = off; > 0 = ms of real time)
 * - `AWS_LAMBDA_FUNCTION_NAME` (set by Lambda): self-recovery re-invokes this function asynchronously with
 *   `{runId, resume: {attempt}}` when a run fails, and continuation with `{runId, continuation: {attempt}}` when it
 *   reaches the 15-minute compute limit with work remaining (needs `lambda:InvokeFunction` on itself; see the
 *   ApiStack)
 * - `MAX_RUN_CONTINUATIONS`: continuations per run (default 12 ≈ 3 hours of real time; 0..48)
 */
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import {
  LAMBDA_TIMEOUT_ABORT,
  MAX_RUN_CONTINUATIONS_CEILING,
  MAX_RUN_RESUMES,
  maxRunContinuationsFromEnv,
  simAutoApproveAfterMsFromEnv,
  type AuthoringRequest,
  type RunResumeRequest,
  type KnowledgeIndex,
  type RunDeps,
  type SecretStore,
  type Store,
  type TraceStore,
  type WallClock,
} from '@ica/schema';
import {
  DynamoStore,
  S3TraceStore,
  SecretsManagerSecretStore,
  envHydratedSecretNames,
  hydrateEnvFromSecrets,
  lambdaSecretIds,
  withRetry,
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

/**
 * Async invocation payload from the API: `{ runId }`, plus `authoring: {text, label?}` for a flight-context run whose
 * scenario is prepared from the duty manager's (screened) free text before the world starts.
 */
export interface RunInvocation {
  runId: string;
  authoring?: AuthoringRequest;
  /** Self-recovery: resume the run from its event log (attempt 1..MAX_RUN_RESUMES). */
  resume?: { attempt: number };
  /** Continuation: carry on in this fresh invocation after the previous one reached the compute limit. */
  continuation?: { attempt: number };
}

/** Validate the (internal, but still untrusted) resume part of an invocation; malformed → ignored. */
export function parseResume(x: unknown): { attempt: number } | undefined {
  if (!x || typeof x !== 'object') return undefined;
  const attempt = (x as { attempt?: unknown }).attempt;
  return typeof attempt === 'number' &&
    Number.isInteger(attempt) &&
    attempt >= 1 &&
    attempt <= MAX_RUN_RESUMES
    ? { attempt }
    : undefined;
}

/** Validate the (internal, but still untrusted) continuation part of an invocation; malformed → ignored. */
export function parseContinuation(x: unknown): { attempt: number } | undefined {
  if (!x || typeof x !== 'object') return undefined;
  const attempt = (x as { attempt?: unknown }).attempt;
  return typeof attempt === 'number' &&
    Number.isInteger(attempt) &&
    attempt >= 1 &&
    attempt <= MAX_RUN_CONTINUATIONS_CEILING
    ? { attempt }
    : undefined;
}

/**
 * Self-recovery: an asynchronous self-invoke (`InvocationType: 'Event'`) of this function with
 * `{runId, resume: {attempt}}`. Retried on transient errors; throws when it cannot be scheduled.
 */
export function lambdaSelfInvoker(
  functionName: string,
  client: Pick<LambdaClient, 'send'> = new LambdaClient({}),
): (req: RunResumeRequest) => Promise<void> {
  return async ({ runId, attempt, kind }) => {
    const payload =
      kind === 'continuation' ? { runId, continuation: { attempt } } : { runId, resume: { attempt } };
    const res = await withRetry(() =>
      client.send(
        new InvokeCommand({
          FunctionName: functionName,
          InvocationType: 'Event',
          Payload: new TextEncoder().encode(JSON.stringify(payload)),
        }),
      ),
    );
    if (res.StatusCode !== 202) throw new Error(`${kind ?? 'resume'} invoke returned ${res.StatusCode}`);
  };
}

/** Validate the (untrusted) authoring part of an invocation; malformed → ignored (the template scenario stands). */
export function parseAuthoring(x: unknown): AuthoringRequest | undefined {
  if (!x || typeof x !== 'object') return undefined;
  const { text, label } = x as { text?: unknown; label?: unknown };
  if (typeof text !== 'string' || !text.trim() || text.length > 4000) return undefined;
  return { text, ...(typeof label === 'string' && label.length <= 80 ? { label } : {}) };
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
  /** Self-recovery: schedule a resume (default: async self-invoke of `AWS_LAMBDA_FUNCTION_NAME`). */
  scheduleResume?: (req: RunResumeRequest) => Promise<void>;
  /** Tests: a virtual wall clock. */
  clock?: WallClock;
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
      simAutoApproveAfterMs: simAutoApproveAfterMsFromEnv(env),
      maxRunContinuations: maxRunContinuationsFromEnv(env),
      ...(d.clock ? { clock: d.clock } : {}),
    };
    const functionName = env.AWS_LAMBDA_FUNCTION_NAME;
    const scheduleResume = d.scheduleResume ?? (functionName ? lambdaSelfInvoker(functionName) : undefined);
    if (scheduleResume) deps.scheduleResume = scheduleResume;
    const ac = new AbortController();
    // About to time out: stop with a reason the runtime recognises (work remaining → continuation, not "completed").
    const timer = context
      ? setInterval(() => {
          if (context.getRemainingTimeInMillis() < STOP_MARGIN_MS) ac.abort(LAMBDA_TIMEOUT_ABORT);
        }, d.guardIntervalMs ?? 1_000)
      : undefined;
    if (context && context.getRemainingTimeInMillis() < STOP_MARGIN_MS) ac.abort(LAMBDA_TIMEOUT_ABORT);
    try {
      const authoring = parseAuthoring(event.authoring);
      const resume = parseResume(event.resume);
      const continuation = resume ? undefined : parseContinuation(event.continuation);
      const result = await executeRun({
        runId: event.runId,
        deps,
        signal: ac.signal,
        ...(authoring && !resume && !continuation ? { authoring } : {}),
        ...(resume ? { resume } : {}),
        ...(continuation ? { continuation } : {}),
      });
      console.log(
        JSON.stringify({
          msg: 'run finished',
          runId: event.runId,
          status: result.status,
          reason: result.reason,
          ...(resume ? { resumeAttempt: resume.attempt } : {}),
          ...(continuation ? { continuationAttempt: continuation.attempt } : {}),
          ...(result.error ? { error: result.error.slice(0, 300) } : {}),
        }),
      );
      return result;
    } finally {
      if (timer) clearInterval(timer);
    }
  };
}

export const handler = createRunHandler(() => (containerDeps ??= defaultDeps()));
