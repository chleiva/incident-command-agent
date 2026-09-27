/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Dense vector search backends for the knowledge retriever:
 *   memory     cosine over vectors held in the Lambda/process (int8 `embeddings.bin` or float `vectors/`)
 *   s3vectors  Amazon S3 Vectors `QueryVectors` (cosine index; key = chunkId; metadata filter on collection and
 *              jurisdiction). Needs `s3vectors:QueryVectors` + `s3vectors:GetVectors` (the latter because the query
 *              uses a metadata filter).
 */
import {
  S3VectorsClient,
  QueryVectorsCommand,
  type QueryVectorsCommandInput,
} from '@aws-sdk/client-s3vectors';
import { cosineQuantised, vectorFilter } from '@ica/kb';
import type { Jurisdiction, KnowledgeCollection } from '@ica/schema';

export interface VectorQuery {
  topK: number;
  collections?: KnowledgeCollection[];
  jurisdiction?: Jurisdiction;
  signal?: AbortSignal;
}

export interface VectorHit {
  /** chunkId */
  key: string;
  /** Cosine similarity (higher is better). */
  score: number;
}

export interface VectorSearch {
  kind: 'memory' | 's3vectors';
  query(vector: Float32Array, q: VectorQuery): Promise<VectorHit[]>;
}

/** In-memory cosine search; `allowed(i)` applies the collection/jurisdiction filter over chunk i. */
export function memoryVectorSearch(
  keys: string[],
  score: (q: Float32Array, i: number) => number,
  allowed: (i: number, q: VectorQuery) => boolean,
): VectorSearch {
  return {
    kind: 'memory',
    async query(vector, q) {
      const sims: [number, number][] = [];
      for (let i = 0; i < keys.length; i++) if (allowed(i, q)) sims.push([i, score(vector, i)]);
      sims.sort((a, b) => b[1] - a[1]);
      return sims.slice(0, q.topK).map(([i, s]) => ({ key: keys[i], score: s }));
    },
  };
}

/** Scorer over int8-quantised vectors (`embeddings.bin` + `scales.bin`). */
export const int8Scorer =
  (data: Int8Array, scales: Float32Array, dim: number) => (q: Float32Array, i: number) =>
    cosineQuantised(q, data, scales, i, dim);

/** Scorer over L2-normalised float vectors. */
export const floatScorer = (vectors: Float32Array[]) => (q: Float32Array, i: number) => {
  const v = vectors[i];
  let dot = 0;
  for (let j = 0; j < v.length; j++) dot += q[j] * v[j];
  return dot;
};

/** Minimal S3 Vectors seam (tests inject a fake). */
export interface S3VectorsLike {
  send(
    cmd: QueryVectorsCommand,
    opts?: { abortSignal?: AbortSignal },
  ): Promise<{
    vectors?: { key?: string; distance?: number }[];
  }>;
}

export interface S3VectorSearchOptions {
  bucket: string;
  index: string;
  region?: string;
  client?: S3VectorsLike;
}

/** S3 Vectors QueryVectors with a metadata filter; cosine distance → similarity (1 − distance). */
export function s3VectorSearch(o: S3VectorSearchOptions): VectorSearch {
  let client = o.client;
  return {
    kind: 's3vectors',
    async query(vector, q) {
      client ??= new S3VectorsClient({ region: o.region, maxAttempts: 2 }) as unknown as S3VectorsLike;
      const filter = vectorFilter({ collections: q.collections, jurisdiction: q.jurisdiction });
      const res = await client.send(
        new QueryVectorsCommand({
          vectorBucketName: o.bucket,
          indexName: o.index,
          topK: q.topK,
          queryVector: { float32: Array.from(vector) },
          returnDistance: true,
          returnMetadata: false,
          ...(filter ? { filter: filter as QueryVectorsCommandInput['filter'] } : {}),
        }),
        { abortSignal: q.signal },
      );
      return (res.vectors ?? [])
        .filter((v): v is { key: string; distance?: number } => typeof v.key === 'string')
        .map((v) => ({ key: v.key, score: 1 - (v.distance ?? 1) }));
    },
  };
}
