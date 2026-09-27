/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * npm run kb:build [-- --only asrs,mmel] [-- --refresh asrs] [-- --embeddings none|local|cohere]
 *
 * Downloads each source into data/raw/ (never committed), extracts and chunks it with the per-collection structural
 * strategies (cached per step in data/raw/chunks/<step>.jsonl, so re-runs are resumable and idempotent; caches from
 * an older chunk format are rebuilt), embeds header + text (cached by text hash in data/raw/emb-cache-*.jsonl, so
 * reruns never re-pay), and writes the index to data/index/ (`npm run kb:upload` syncs it to S3 and to the S3 Vectors
 * index). A failing source warns and the build continues.
 *
 * `KB_EMBEDDINGS=cohere` (Cohere Embed v4 via `eu.cohere.embed-v4:0`, 1536 dims) stores vectors in Amazon S3 Vectors:
 * the Lambda-loaded files (chunks + BM25) carry no vectors, and `data/index/vectors/` holds them for kb:upload.
 * The Lambda-loaded files must stay under 50 MB.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { chunkingReport } from '../src/chunking';
import { COHERE_EMBED_USD_PER_MTOK } from '../src/cohere';
import { createEmbedder, embeddingProviderFromEnv } from '../src/embed';
import { embedAllWithCache, openVectorCache } from '../src/embed-cache';
import {
  VECTOR_FILES,
  indexText,
  parseChunks,
  serialiseIndex,
  sourceFamily,
  vectorMetadata,
  vectorsToBytes,
  type ChunkRecord,
  type IndexManifest,
  type VectorStoreKind,
} from '../src/format';
import { INDEX_DIR, RAW_DIR } from './lib';
import { aaibStep } from './sources/aaib';
import { aidsStep } from './sources/aids';
import { asrsStep } from './sources/asrs';
import { easaStep } from './sources/easa';
import { buildDelayCostParams } from './sources/eurocontrol';
import { mmelStep } from './sources/mmel';
import { caaRightsStep, eu261Step } from './sources/passenger-rights';
import { airbusStep, cap642Step, faaAcStep, fsfStep } from './sources/procedures';
import type { SourceStep } from './sources/types';

const MAX_BYTES = 50 * 1024 * 1024;
const STEPS: SourceStep[] = [
  mmelStep,
  easaStep,
  eu261Step,
  caaRightsStep,
  faaAcStep,
  cap642Step,
  airbusStep,
  fsfStep,
  asrsStep,
  aaibStep,
  aidsStep,
];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** A step cache written by the structural chunkers (every chunk has a docId and a header). */
function readStepCache(file: string): ChunkRecord[] | null {
  if (!existsSync(file)) return null;
  const chunks = parseChunks(readFileSync(file, 'utf8'));
  return chunks.length && chunks.every((c) => c.docId && c.header) ? chunks : null;
}

async function main() {
  const only = arg('only')?.split(',');
  const refresh = new Set((arg('refresh') ?? process.env.KB_REFRESH ?? '').split(',').filter(Boolean));
  const rawProvider =
    (arg('embeddings') as IndexManifest['embeddings']['provider']) ?? embeddingProviderFromEnv();
  const provider = rawProvider === 'bedrock' ? 'cohere' : rawProvider;
  mkdirSync(RAW_DIR + 'chunks', { recursive: true });

  const report: {
    step: string;
    status: 'ok' | 'cached' | 'failed' | 'skipped';
    chunks: number;
    error?: string;
  }[] = [];
  const all: ChunkRecord[] = [];
  for (const step of STEPS) {
    const cacheFile = `${RAW_DIR}chunks/${step.id}.jsonl`;
    if (only && !only.includes(step.id)) {
      // Still include cached chunks from earlier runs so --only never shrinks the index.
      const cached = readStepCache(cacheFile);
      if (cached) {
        all.push(...cached);
        report.push({ step: step.id, status: 'cached', chunks: cached.length });
      }
      continue;
    }
    if (step.enabled && !step.enabled()) {
      report.push({ step: step.id, status: 'skipped', chunks: 0 });
      console.log(`- ${step.id}: skipped`);
      continue;
    }
    const cached = refresh.has(step.id) ? null : readStepCache(cacheFile);
    if (cached) {
      all.push(...cached);
      report.push({ step: step.id, status: 'cached', chunks: cached.length });
      console.log(`= ${step.id}: ${cached.length} chunks (cached)`);
      continue;
    }
    const t0 = Date.now();
    try {
      console.log(`> ${step.id}…`);
      const chunks = await step.run();
      writeFileSync(cacheFile, chunks.map((c) => JSON.stringify(c)).join('\n') + '\n');
      all.push(...chunks);
      report.push({ step: step.id, status: 'ok', chunks: chunks.length });
      console.log(`✓ ${step.id}: ${chunks.length} chunks in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    } catch (err) {
      report.push({ step: step.id, status: 'failed', chunks: 0, error: String(err) });
      console.warn(`! ${step.id} FAILED (continuing): ${String(err)}`);
    }
  }

  try {
    const n = await buildDelayCostParams();
    report.push({ step: 'eurocontrol-delay-cost', status: 'ok', chunks: 0 });
    console.log(`✓ eurocontrol: ${n} tables → data/params/delay-cost.json`);
  } catch (err) {
    report.push({ step: 'eurocontrol-delay-cost', status: 'failed', chunks: 0, error: String(err) });
    console.warn(`! eurocontrol FAILED (continuing): ${String(err)}`);
  }

  // De-duplicate chunk ids (first wins).
  const seen = new Set<string>();
  const chunks = all.filter((c) => (seen.has(c.chunkId) ? false : (seen.add(c.chunkId), true)));
  if (!chunks.length) throw new Error('no chunks from any source');

  const chunking = chunkingReport(chunks);
  console.log('\nchunking (tokens ≈ words/0.75 of header + text):');
  for (const [col, st] of Object.entries(chunking))
    console.log(
      `  ${col.padEnd(17)} ${String(st.chunks).padStart(6)} chunks ${String(st.docs).padStart(6)} docs  ` +
        `p50 ${st.tokens.p50}  p90 ${st.tokens.p90}  max ${st.tokens.max}  total ${st.tokens.total}`,
    );

  const cohere = provider === 'cohere';
  const store: VectorStoreKind =
    provider === 'none'
      ? 'none'
      : ((process.env.KB_VECTOR_STORE as VectorStoreKind | undefined) ?? (cohere ? 's3vectors' : 'memory'));
  const embedReport: Record<string, unknown> = { provider, store };
  let embeddings: { vectors: Float32Array[]; dim: number } | undefined;
  let model: string | undefined;
  if (provider !== 'none') {
    try {
      const embedder = (await createEmbedder({
        provider,
        cacheDir: process.env.KB_MODEL_CACHE,
        model: cohere ? process.env.KB_EMBED_MODEL || undefined : undefined,
        dim: cohere && process.env.KB_EMBED_DIMS ? Number(process.env.KB_EMBED_DIMS) : undefined,
      }))!;
      if (cohere && embedder.provider === 'cohere') {
        // Stay under the Bedrock quota (300k tokens / 20 requests per minute by default) instead of relying on
        // throttling retries: replace the embedder with a rate-limited one.
        const { cohereEmbedder } = await import('../src/cohere');
        Object.assign(
          embedder,
          cohereEmbedder({
            model: embedder.model,
            dim: embedder.dim,
            tokensPerMinute: Number(process.env.KB_EMBED_TPM ?? 250_000),
            requestsPerMinute: Number(process.env.KB_EMBED_RPM ?? 18),
          }),
        );
      }
      model = embedder.model;
      const cacheFile = `${RAW_DIR}emb-cache-${provider}-${embedder.model.replace(/[^a-z0-9]+/gi, '_')}-${embedder.dim}.jsonl`;
      const cache = openVectorCache(cacheFile);
      console.log(
        `> embedding ${chunks.length} chunks with ${provider}:${embedder.model} (${cache.size} cached)`,
      );
      const t0 = Date.now();
      const res = await embedAllWithCache(chunks.map(indexText), embedder, cache, {
        onProgress: (done, total) => process.stdout.write(`  ${done}/${total}\r`),
      });
      embeddings = { vectors: res.vectors, dim: embedder.dim };
      const tokens = embedder.usage?.inputTokens ?? 0;
      Object.assign(embedReport, {
        model,
        dim: embedder.dim,
        embedded: res.embedded,
        cached: res.cached,
        calls: embedder.usage?.calls ?? 0,
        retries: embedder.usage?.retries ?? 0,
        inputTokens: tokens,
        usd: cohere ? Math.round((tokens / 1e6) * COHERE_EMBED_USD_PER_MTOK * 10000) / 10000 : 0,
        seconds: Math.round((Date.now() - t0) / 1000),
      });
      console.log(`\n  embedded ${res.embedded}, cached ${res.cached}, input tokens ${tokens}`);
    } catch (err) {
      console.warn(`! embeddings (${provider}) failed; writing a BM25-only index: ${String(err)}`);
      embedReport.error = String(err);
    }
  }

  const bySource = new Map<string, IndexManifest['sources'][number]>();
  for (const c of chunks) {
    const key = sourceFamily(c.sourceId);
    const s = bySource.get(key) ?? { sourceId: key, collection: c.collection, chunks: 0, licence: c.licence };
    s.chunks++;
    bySource.set(key, s);
  }
  const files = serialiseIndex(
    chunks,
    {
      builtAt: new Date().toISOString(),
      embeddings: embeddings
        ? {
            provider,
            model,
            dim: embeddings.dim,
            store,
            vectorCount: embeddings.vectors.length,
            ...(store === 'memory' ? { quantisation: 'int8' as const } : {}),
            ...(cohere ? { profile: model, inputType: 'search_document' } : {}),
          }
        : { provider: 'none', store: 'none' },
      sources: [...bySource.values()],
      chunking,
      notes: report.map(
        (r) => `${r.step}: ${r.status}${r.error ? ` (${r.error})` : ''} — ${r.chunks} chunks`,
      ),
    },
    embeddings,
  );
  if (existsSync(INDEX_DIR)) rmSync(INDEX_DIR, { recursive: true });
  mkdirSync(INDEX_DIR, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(INDEX_DIR + name, content);
  const lambdaBytes = readdirSync(INDEX_DIR).reduce((a, f) => a + statSync(INDEX_DIR + f).size, 0);
  let vectorBytes = 0;
  if (embeddings && store === 's3vectors') {
    mkdirSync(INDEX_DIR + VECTOR_FILES.dir, { recursive: true });
    const data = vectorsToBytes(embeddings.vectors, embeddings.dim);
    writeFileSync(INDEX_DIR + VECTOR_FILES.data, data);
    writeFileSync(
      INDEX_DIR + VECTOR_FILES.keys,
      chunks.map((c) => JSON.stringify({ key: c.chunkId, metadata: vectorMetadata(c) })).join('\n') + '\n',
    );
    vectorBytes = data.byteLength;
  }
  writeFileSync(
    INDEX_DIR + 'build-report.json',
    JSON.stringify(
      {
        builtAt: new Date().toISOString(),
        steps: report,
        chunking,
        embeddings: embedReport,
        lambdaBytes,
        vectorBytes,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    `\nindex: ${chunks.length} chunks, Lambda-loaded files ${(lambdaBytes / 1024 / 1024).toFixed(1)} MB` +
      `${vectorBytes ? `, vectors ${(vectorBytes / 1024 / 1024).toFixed(1)} MB (for S3 Vectors)` : ''}, ` +
      `embeddings=${embeddings ? `${provider}:${model} (${store})` : 'none'}`,
  );
  for (const r of report)
    console.log(`  ${r.status.padEnd(7)} ${r.step} ${r.chunks}${r.error ? `  ${r.error}` : ''}`);
  if (lambdaBytes > MAX_BYTES) {
    console.error(
      `Lambda-loaded index is ${(lambdaBytes / 1024 / 1024).toFixed(1)} MB (> 50 MB); lower KB_ASRS_CAP / KB_AAIB_CAP`,
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
