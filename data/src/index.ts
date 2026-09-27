/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * @ica/kb — knowledge-base build pipeline (scripts/), airports data, and the shared pieces the runtime retriever
 * needs to read an index exactly as it was built (tokenizer, BM25, int8 embeddings, embedder factory).
 */
export * from './text';
export * from './format';
export * from './stations';
export {
  createEmbedder,
  embeddingProviderFromEnv,
  LOCAL_DIM,
  LOCAL_MODEL,
  type Embedder,
  type EmbedderOptions,
} from './embed';
