/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * @ica/kb — knowledge-base build pipeline (scripts/), airports data, and the shared pieces the runtime retriever
 * needs to read an index exactly as it was built (tokenizer, BM25, int8 embeddings, context headers, embedder
 * factory, Cohere Embed v4 client).
 */
export * from './text';
export * from './format';
export * from './stations';
export * from './chunking';
export {
  createEmbedder,
  embeddingProviderFromEnv,
  LOCAL_DIM,
  LOCAL_MODEL,
  type EmbedInputType,
  type EmbedUsage,
  type Embedder,
  type EmbedderOptions,
} from './embed';
export {
  COHERE_EMBED_DIM,
  COHERE_EMBED_MODEL,
  COHERE_EMBED_USD_PER_MTOK,
  COHERE_MAX_BATCH,
  bedrockInvoker,
  cohereEmbedder,
  isRetryable,
  mapLimit,
  withRetry,
  type CohereEmbedderOptions,
  type InvokeFn,
  type InvokeResult,
} from './cohere';
