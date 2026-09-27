/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Cohere Embed v4 on Amazon Bedrock (`KB_EMBEDDINGS=cohere`). Invoked through the EU cross-region inference profile
 * `eu.cohere.embed-v4:0` (the bare model id rejects on-demand calls), which routes within EU regions only. Chunks are
 * embedded with `input_type: search_document`, queries with `search_query`; 1536-dim float vectors.
 *
 * Batching: up to 96 texts per InvokeModel call (the Cohere limit), `concurrency` calls in flight, an optional
 * client-side sliding-window limiter under the account's quotas (off by default; kb:build sets 250k tokens and 18
 * requests per minute because this account's quota for the Embed v4 cross-region profile is 300k tokens / 20
 * requests per minute; `KB_EMBED_TPM`, `KB_EMBED_RPM`), and exponential backoff with jitter (capped at 30 s) on throttling / 5xx. Input tokens are read from Bedrock's `x-amzn-bedrock-input-token-count`
 * response header and accumulated in `usage`.
 */
import type { EmbedInputType, EmbedUsage, Embedder } from './embed';
import { l2normalise } from './format';

export const COHERE_EMBED_MODEL = 'eu.cohere.embed-v4:0';
export const COHERE_EMBED_DIM = 1536;
/** Cohere v4 accepts at most 96 texts per request. */
export const COHERE_MAX_BATCH = 96;
/** Characters per text sent (≈ 5k tokens; chunks are far below this, it only guards against pathological input). */
export const COHERE_MAX_CHARS = 20_000;
/** USD per 1M input tokens (Bedrock on-demand, Cohere Embed v4 text; checked 2026-09-27). */
export const COHERE_EMBED_USD_PER_MTOK = 0.12;

export interface InvokeResult {
  body: unknown;
  inputTokens?: number;
}
/** Minimal Bedrock InvokeModel seam (tests inject a fake). */
export type InvokeFn = (modelId: string, body: unknown, signal?: AbortSignal) => Promise<InvokeResult>;

export interface CohereEmbedderOptions {
  model?: string;
  dim?: number;
  region?: string;
  batchSize?: number;
  concurrency?: number;
  maxAttempts?: number;
  /** Base backoff in ms (doubles per attempt, plus jitter; capped at maxBackoffMs). */
  backoffMs?: number;
  maxBackoffMs?: number;
  /** Client-side rate limits (per rolling minute). Estimated tokens ≈ chars / 4. 0 disables. */
  tokensPerMinute?: number;
  requestsPerMinute?: number;
  now?: () => number;
  invoke?: InvokeFn;
  sleep?: (ms: number) => Promise<void>;
}

/** A Bedrock runtime InvokeModel function that also reports the input-token header. */
export async function bedrockInvoker(region?: string): Promise<InvokeFn> {
  const sdk = await import('@aws-sdk/client-bedrock-runtime');
  const client = new sdk.BedrockRuntimeClient({
    region: region ?? process.env.AWS_REGION ?? 'eu-west-2',
    maxAttempts: 1,
  });
  client.middlewareStack.add(
    (next) => async (args) => {
      const r = await next(args);
      const headers = (r.response as { headers?: Record<string, string> } | undefined)?.headers ?? {};
      const n = Number(headers['x-amzn-bedrock-input-token-count']);
      if (Number.isFinite(n) && r.output) (r.output as { $inputTokens?: number }).$inputTokens = n;
      return r;
    },
    { step: 'initialize', name: 'icaInputTokenCount' },
  );
  const dec = new TextDecoder();
  return async (modelId, body, signal) => {
    const res = await client.send(
      new sdk.InvokeModelCommand({
        modelId,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify(body),
      }),
      { abortSignal: signal },
    );
    return {
      body: JSON.parse(dec.decode(res.body)),
      inputTokens: (res as { $inputTokens?: number }).$inputTokens,
    };
  };
}

/** True for errors worth retrying (throttling, timeouts, 5xx). */
export function isRetryable(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number }; $retryable?: unknown };
  const code = e?.$metadata?.httpStatusCode ?? 0;
  return (
    !!e?.$retryable ||
    code === 429 ||
    code >= 500 ||
    /Throttl|TooManyRequests|ServiceUnavailable|ModelNotReady|InternalServer|Timeout|ECONNRESET/i.test(
      e?.name ?? String(err),
    )
  );
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  o: {
    maxAttempts: number;
    backoffMs: number;
    maxBackoffMs?: number;
    sleep: (ms: number) => Promise<void>;
    onRetry?: () => void;
  },
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= o.maxAttempts || !isRetryable(err)) throw err;
      o.onRetry?.();
      const delay = Math.min(o.backoffMs * 2 ** (attempt - 1), o.maxBackoffMs ?? 30_000);
      await o.sleep(delay + Math.floor(Math.random() * delay * 0.5));
    }
  }
}

/**
 * Sliding-window (60 s) limiter for tokens and requests per minute. `acquire(n)` waits until n more tokens and one
 * more request fit in the window. Deterministic with injected `now`/`sleep` (tests).
 */
export class MinuteRateLimiter {
  private readonly events: { t: number; tokens: number }[] = [];
  constructor(
    private readonly tpm: number,
    private readonly rpm: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  async acquire(tokens: number): Promise<void> {
    for (;;) {
      const t = this.now();
      while (this.events.length && t - this.events[0].t >= 60_000) this.events.shift();
      const used = this.events.reduce((a, e) => a + e.tokens, 0);
      const fitsTokens = !this.tpm || used + tokens <= this.tpm || this.events.length === 0;
      const fitsRequests = !this.rpm || this.events.length < this.rpm;
      if (fitsTokens && fitsRequests) {
        this.events.push({ t, tokens });
        return;
      }
      await this.sleep(Math.max(50, 60_000 - (t - this.events[0].t)));
    }
  }
}

/** Run `fn` over `items` with at most `concurrency` in flight; results keep input order. */
export async function mapLimit<I, O>(items: I[], concurrency: number, fn: (x: I, i: number) => Promise<O>) {
  const out = new Array<O>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker));
  return out;
}

export function cohereEmbedder(opts: CohereEmbedderOptions = {}): Embedder {
  const model = opts.model ?? COHERE_EMBED_MODEL;
  const dim = opts.dim ?? COHERE_EMBED_DIM;
  const batchSize = Math.min(opts.batchSize ?? COHERE_MAX_BATCH, COHERE_MAX_BATCH);
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const usage: EmbedUsage = { inputTokens: 0, calls: 0, retries: 0 };
  let invokeP: Promise<InvokeFn> | undefined = opts.invoke ? Promise.resolve(opts.invoke) : undefined;
  const envNum = (k: string, d: number) => {
    const v = Number(process.env[k]);
    return Number.isFinite(v) && process.env[k] ? v : d;
  };
  const limiter = new MinuteRateLimiter(
    opts.tokensPerMinute ?? envNum('KB_EMBED_TPM', 0),
    opts.requestsPerMinute ?? envNum('KB_EMBED_RPM', 0),
    opts.now,
    sleep,
  );
  return {
    provider: 'cohere',
    model,
    dim,
    usage,
    async embed(texts, o = {}) {
      const inputType: EmbedInputType = o.inputType ?? 'search_document';
      const invoke = await (invokeP ??= bedrockInvoker(opts.region));
      const batches: string[][] = [];
      for (let i = 0; i < texts.length; i += batchSize) batches.push(texts.slice(i, i + batchSize));
      const results = await mapLimit(batches, opts.concurrency ?? 2, (batch) =>
        withRetry(
          async () => {
            await limiter.acquire(
              Math.ceil(batch.reduce((a, t) => a + Math.min(t.length, COHERE_MAX_CHARS), 0) / 4),
            );
            const res = await invoke(
              model,
              {
                texts: batch.map((t) => t.slice(0, COHERE_MAX_CHARS)),
                input_type: inputType,
                embedding_types: ['float'],
                output_dimension: dim,
                truncate: 'RIGHT',
              },
              o.signal,
            );
            usage.calls++;
            usage.inputTokens += res.inputTokens ?? 0;
            const body = res.body as { embeddings?: { float?: number[][] } | number[][] };
            const vecs = Array.isArray(body.embeddings) ? body.embeddings : body.embeddings?.float;
            if (!vecs || vecs.length !== batch.length)
              throw new Error(`cohere embed: expected ${batch.length} vectors, got ${vecs?.length ?? 0}`);
            return vecs.map((v) => {
              if (v.length !== dim) throw new Error(`cohere embed: expected dim ${dim}, got ${v.length}`);
              return l2normalise(Float32Array.from(v));
            });
          },
          {
            maxAttempts: opts.maxAttempts ?? 10,
            backoffMs: opts.backoffMs ?? 1000,
            maxBackoffMs: opts.maxBackoffMs ?? 30_000,
            sleep,
            onRetry: () => usage.retries++,
          },
        ),
      );
      return results.flat();
    },
  };
}
