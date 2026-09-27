/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Pluggable embeddings (`KB_EMBEDDINGS`):
 *   local   (default) transformers.js + all-MiniLM-L6-v2, free, no key, runs on CPU.
 *   openai  text-embedding-3-small (OPENAI_API_KEY; paid).
 *   cohere  Cohere Embed v4 on Amazon Bedrock via the EU cross-region inference profile `eu.cohere.embed-v4:0`
 *           (1536 dims, float; `search_document` for chunks, `search_query` for queries). AWS credentials; paid
 *           (≈ USD 0.12 per 1M input tokens). `bedrock` is accepted as an alias.
 *   none    BM25 only.
 * The same provider/model embeds queries at runtime (the manifest records which one built the index).
 */
import { l2normalise, type EmbeddingProvider } from './format';
import { cohereEmbedder } from './cohere';

export type EmbedInputType = 'search_document' | 'search_query';

export interface EmbedUsage {
  /** Provider-reported input tokens (cohere: Bedrock `x-amzn-bedrock-input-token-count`). */
  inputTokens: number;
  calls: number;
  retries: number;
}

export interface Embedder {
  provider: EmbeddingProvider;
  model: string;
  dim: number;
  /** `inputType` matters for asymmetric models (cohere); others ignore it. Default `search_document`. */
  embed(
    texts: string[],
    opts?: { inputType?: EmbedInputType; signal?: AbortSignal },
  ): Promise<Float32Array[]>;
  /** Running usage counters (cohere). */
  usage?: EmbedUsage;
}

export const LOCAL_MODEL = 'Xenova/all-MiniLM-L6-v2';
export const LOCAL_DIM = 384;

export interface EmbedderOptions {
  provider: EmbeddingProvider;
  model?: string;
  /** Directory for downloaded model files (Lambda: a /tmp path, or a bundled/S3-synced directory). */
  cacheDir?: string;
  /** Only use model files already present in `cacheDir` (no network). */
  localOnly?: boolean;
  apiKey?: string;
  /** cohere: output dimension (256, 512, 1024, 1536; default 1536). */
  dim?: number;
  /** cohere: region of the Bedrock runtime client (default AWS_REGION or eu-west-2). */
  region?: string;
}

export function embeddingProviderFromEnv(env = process.env): EmbeddingProvider {
  const v = (env.KB_EMBEDDINGS ?? 'local').toLowerCase();
  if (v === 'bedrock') return 'cohere';
  if (v === 'local' || v === 'openai' || v === 'cohere' || v === 'none') return v;
  throw new Error(`KB_EMBEDDINGS must be local|openai|cohere|none (got "${v}")`);
}

export async function createEmbedder(opts: EmbedderOptions): Promise<Embedder | null> {
  switch (opts.provider) {
    case 'none':
      return null;
    case 'local':
      return localEmbedder(opts);
    case 'openai':
      return openAiEmbedder(opts);
    case 'cohere':
    case 'bedrock':
      return cohereEmbedder({ model: opts.model, dim: opts.dim, region: opts.region });
  }
}

async function localEmbedder(opts: EmbedderOptions): Promise<Embedder> {
  const model = opts.model ?? LOCAL_MODEL;
  const tf = await import('@huggingface/transformers');
  if (opts.cacheDir) tf.env.cacheDir = opts.cacheDir;
  if (opts.localOnly) tf.env.allowRemoteModels = false;
  const extractor = await tf.pipeline('feature-extraction', model, { dtype: 'fp32' });
  return {
    provider: 'local',
    model,
    dim: LOCAL_DIM,
    async embed(texts) {
      const out: Float32Array[] = [];
      const batch = 16;
      for (let i = 0; i < texts.length; i += batch) {
        const slice = texts.slice(i, i + batch);
        const t = await extractor(slice, { pooling: 'mean', normalize: true });
        const data = t.data as Float32Array;
        const dim = t.dims[t.dims.length - 1];
        for (let j = 0; j < slice.length; j++)
          out.push(Float32Array.from(data.subarray(j * dim, (j + 1) * dim)));
      }
      return out;
    },
  };
}

async function openAiEmbedder(opts: EmbedderOptions): Promise<Embedder> {
  const model = opts.model ?? 'text-embedding-3-small';
  const key = opts.apiKey ?? process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY is required for KB_EMBEDDINGS=openai');
  return {
    provider: 'openai',
    model,
    dim: 1536,
    async embed(texts) {
      const out: Float32Array[] = [];
      for (let i = 0; i < texts.length; i += 96) {
        const res = await fetch('https://api.openai.com/v1/embeddings', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
          body: JSON.stringify({ model, input: texts.slice(i, i + 96).map((t) => t.slice(0, 8000)) }),
        });
        if (!res.ok) throw new Error(`OpenAI embeddings failed: HTTP ${res.status}`);
        const body = (await res.json()) as { data: { embedding: number[] }[] };
        for (const d of body.data) out.push(l2normalise(Float32Array.from(d.embedding)));
      }
      return out;
    },
  };
}
