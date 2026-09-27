/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Cohere Rerank 3.5 on Amazon Bedrock (`cohere.rerank-v3-5:0`). The model is not offered in eu-west-2, so it is
 * invoked in eu-central-1 (Frankfurt) by default (`KB_RERANK_REGION`): the query and the candidate chunk texts leave
 * the deployment region but stay in the EU. ≈ USD 2 per 1,000 queries (one query ≤ 100 documents = 1 search unit).
 */
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import type { InvokeFn } from '@ica/kb';

export const RERANK_MODEL = 'cohere.rerank-v3-5:0';
export const RERANK_REGION = 'eu-central-1';
/** USD per rerank query (≤ 100 documents); Bedrock on-demand pricing checked 2026-09-27. */
export const RERANK_USD_PER_QUERY = 0.002;

export interface RerankResult {
  /** Index into the documents passed in. */
  index: number;
  /** Relevance score 0–1. */
  score: number;
}

export interface Reranker {
  model: string;
  rerank(query: string, documents: string[], topN: number, signal?: AbortSignal): Promise<RerankResult[]>;
}

export interface CohereRerankerOptions {
  model?: string;
  region?: string;
  /** Tests inject a fake Bedrock InvokeModel. */
  invoke?: InvokeFn;
}

function defaultInvoke(region: string): InvokeFn {
  const client = new BedrockRuntimeClient({ region, maxAttempts: 2 });
  const dec = new TextDecoder();
  return async (modelId, body, signal) => {
    const res = await client.send(
      new InvokeModelCommand({
        modelId,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify(body),
      }),
      { abortSignal: signal },
    );
    return { body: JSON.parse(dec.decode(res.body)) };
  };
}

/** Bedrock body: `{query, documents[], top_n, api_version: 2}` → `{results: [{index, relevance_score}]}`. */
export function cohereReranker(opts: CohereRerankerOptions = {}): Reranker {
  const model = opts.model ?? RERANK_MODEL;
  let invoke = opts.invoke;
  return {
    model,
    async rerank(query, documents, topN, signal) {
      if (!documents.length) return [];
      invoke ??= defaultInvoke(opts.region ?? RERANK_REGION);
      const res = await invoke(
        model,
        { query, documents, top_n: Math.min(topN, documents.length), api_version: 2 },
        signal,
      );
      const body = res.body as { results?: { index: number; relevance_score: number }[] };
      if (!Array.isArray(body.results)) throw new Error('rerank: no results in the response');
      return body.results
        .filter((r) => Number.isInteger(r.index) && r.index >= 0 && r.index < documents.length)
        .map((r) => ({ index: r.index, score: r.relevance_score }));
    },
  };
}

/**
 * Per-container token bucket for the rerank quota (on-demand Cohere Rerank 3.5 is 3 requests/minute on a new account
 * and not adjustable in Service Quotas). `tryTake()` never waits: when the bucket is empty the caller skips rerank and
 * keeps the fused hybrid order, so a search is never slowed down or failed by the quota.
 */
export class RerankBudget {
  private tokens: number;
  private last: number;
  constructor(
    readonly perMinute: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = perMinute;
    this.last = now();
  }
  private refill(): void {
    const t = this.now();
    this.tokens = Math.min(this.perMinute, this.tokens + ((t - this.last) / 60_000) * this.perMinute);
    this.last = t;
  }
  tryTake(): boolean {
    if (this.perMinute <= 0) return true; // 0 = unlimited
    this.refill();
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
  /** Bedrock throttled us anyway (other containers share the account quota): back off for a full window. */
  drain(): void {
    this.tokens = Math.min(this.tokens, 0);
    this.last = this.now();
  }
  available(): number {
    this.refill();
    return this.tokens;
  }
}

/** True for Bedrock throttling errors. */
export function isThrottle(err: unknown): boolean {
  const e = err as { name?: string; message?: string } | null;
  return (
    !!e &&
    (e.name === 'ThrottlingException' || /throttl|too many requests|rate exceeded/i.test(e.message ?? ''))
  );
}
