/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * npm run kb:build [-- --only asrs,mmel] [-- --refresh asrs] [-- --embeddings none]
 *
 * Downloads each source into data/raw/ (git-ignored), extracts and chunks it (cached per step in
 * data/raw/chunks/<step>.jsonl, so re-runs are resumable and idempotent), embeds the chunks (cached by text hash),
 * and writes the index to data/index/ (git-ignored; `npm run kb:upload` syncs it to S3). A failing source warns and
 * the build continues. The total index must stay under 50 MB.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createEmbedder, embeddingProviderFromEnv } from '../src/embed';
import { indexText, parseChunks, serialiseIndex, type ChunkRecord, type IndexManifest } from '../src/format';
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

async function main() {
  const only = arg('only')?.split(',');
  const refresh = new Set((arg('refresh') ?? process.env.KB_REFRESH ?? '').split(',').filter(Boolean));
  const provider =
    (arg('embeddings') as IndexManifest['embeddings']['provider']) ?? embeddingProviderFromEnv();
  mkdirSync(RAW_DIR + 'chunks', { recursive: true });

  const report: {
    step: string;
    status: 'ok' | 'cached' | 'failed' | 'skipped';
    chunks: number;
    error?: string;
  }[] = [];
  const all: ChunkRecord[] = [];
  for (const step of STEPS) {
    if (only && !only.includes(step.id)) {
      // Still include cached chunks from earlier runs so --only never shrinks the index.
      const cache = `${RAW_DIR}chunks/${step.id}.jsonl`;
      if (existsSync(cache)) {
        const cached = parseChunks(readFileSync(cache, 'utf8'));
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
    const cache = `${RAW_DIR}chunks/${step.id}.jsonl`;
    if (existsSync(cache) && !refresh.has(step.id)) {
      const cached = parseChunks(readFileSync(cache, 'utf8'));
      all.push(...cached);
      report.push({ step: step.id, status: 'cached', chunks: cached.length });
      console.log(`= ${step.id}: ${cached.length} chunks (cached)`);
      continue;
    }
    const t0 = Date.now();
    try {
      console.log(`> ${step.id}…`);
      const chunks = await step.run();
      writeFileSync(cache, chunks.map((c) => JSON.stringify(c)).join('\n') + '\n');
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

  let embeddings: { vectors: Float32Array[]; dim: number } | undefined;
  let model: string | undefined;
  if (provider !== 'none') {
    try {
      const embedder = (await createEmbedder({ provider, cacheDir: process.env.KB_MODEL_CACHE }))!;
      model = embedder.model;
      const cacheFile = `${RAW_DIR}emb-cache-${provider}-${embedder.model.replace(/[^a-z0-9]+/gi, '_')}.jsonl`;
      const cache = new Map<string, string>();
      if (existsSync(cacheFile))
        for (const l of readFileSync(cacheFile, 'utf8').split('\n'))
          if (l) {
            const { h, v } = JSON.parse(l) as { h: string; v: string };
            cache.set(h, v);
          }
      const hashes = chunks.map((c) => createHash('sha1').update(indexText(c)).digest('hex'));
      const todo = chunks.map((c, i) => ({ c, h: hashes[i] })).filter(({ h }) => !cache.has(h));
      console.log(
        `> embedding ${todo.length} new chunks with ${provider}:${embedder.model} (${cache.size} cached)`,
      );
      const batch = 256;
      for (let i = 0; i < todo.length; i += batch) {
        const slice = todo.slice(i, i + batch);
        const vecs = await embedder.embed(slice.map(({ c }) => indexText(c).slice(0, 2000)));
        const lines = slice.map(({ h }, j) => {
          const v = Buffer.from(vecs[j].buffer, vecs[j].byteOffset, vecs[j].byteLength).toString('base64');
          cache.set(h, v);
          return JSON.stringify({ h, v });
        });
        writeFileSync(cacheFile, lines.join('\n') + '\n', { flag: 'a' });
        process.stdout.write(`  ${Math.min(i + batch, todo.length)}/${todo.length}\r`);
      }
      const vectors = hashes.map((h) => {
        const b = Buffer.from(cache.get(h)!, 'base64');
        return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
      });
      embeddings = { vectors, dim: embedder.dim };
    } catch (err) {
      console.warn(`! embeddings (${provider}) failed; writing a BM25-only index: ${String(err)}`);
    }
  }

  const bySource = new Map<string, IndexManifest['sources'][number]>();
  for (const c of chunks) {
    const key = c.sourceId;
    const s = bySource.get(key) ?? { sourceId: key, collection: c.collection, chunks: 0, licence: c.licence };
    s.chunks++;
    bySource.set(key, s);
  }
  const files = serialiseIndex(
    chunks,
    {
      builtAt: new Date().toISOString(),
      embeddings: embeddings
        ? { provider, model, dim: embeddings.dim, quantisation: 'int8' }
        : { provider: 'none' },
      sources: [...bySource.values()],
      notes: report.map(
        (r) => `${r.step}: ${r.status}${r.error ? ` (${r.error})` : ''} — ${r.chunks} chunks`,
      ),
    },
    embeddings,
  );
  if (existsSync(INDEX_DIR)) for (const f of readdirSync(INDEX_DIR)) rmSync(INDEX_DIR + f);
  mkdirSync(INDEX_DIR, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(INDEX_DIR + name, content);
  writeFileSync(INDEX_DIR + 'build-report.json', JSON.stringify(report, null, 2) + '\n');
  const total = readdirSync(INDEX_DIR).reduce((a, f) => a + statSync(INDEX_DIR + f).size, 0);
  console.log(
    `\nindex: ${chunks.length} chunks, ${(total / 1024 / 1024).toFixed(1)} MB, embeddings=${embeddings ? `${provider}:${model}` : 'none'}`,
  );
  for (const r of report)
    console.log(`  ${r.status.padEnd(7)} ${r.step} ${r.chunks}${r.error ? `  ${r.error}` : ''}`);
  if (total > MAX_BYTES) {
    console.error(
      `index is ${(total / 1024 / 1024).toFixed(1)} MB (> 50 MB); lower KB_ASRS_CAP / KB_AAIB_CAP`,
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
