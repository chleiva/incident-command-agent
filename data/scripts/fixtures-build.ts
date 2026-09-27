/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * npm run kb:fixtures -w @ica/kb — rebuilds the committed mini-corpus (data/fixtures/corpus.jsonl, ~30 chunks across
 * all collections, public-domain or permitted text only, no AAIB text) and its tiny prebuilt index
 * (data/fixtures/index/). Needs a previous `npm run kb:build` (reads data/raw/chunks/*.jsonl). Unit tests and CI use
 * the committed output with no network.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createEmbedder } from '../src/embed';
import { INDEX_FILES, indexText, parseChunks, serialiseIndex, type ChunkRecord } from '../src/format';
import { RAW_DIR, writePrettyJson } from './lib';

const FIXTURES = fileURLToPath(new URL('../fixtures/', import.meta.url));
const CAA_DELAYS = 'caa-l-problems-and-rights-flight-delays-and-cancellations-delays';
const CAA_CANCEL = 'caa-ems-and-rights-flight-delays-and-cancellations-cancellations';

export const FIXTURE_CHUNK_IDS = [
  // mel (FAA MMEL, public domain)
  'mmel-49-10-01#1',
  'mmel-52-30-02#1',
  'mmel-52-30-04#1',
  'mmel-25-60-03#1',
  'mmel-32-47-01#1',
  // rules (EASA, EU)
  'easa-ORO.MLR.105#1',
  'easa-ORO.FTL.205#1',
  'easa-ORO.FTL.205#2',
  'easa-ORO.FTL.225#1',
  'easa-CAT.GEN.MPA.105#1',
  // passenger rights (EU 261/2004; UK CAA)
  'eu261-art5#1',
  'eu261-art6#1',
  'eu261-art7#1',
  'eu261-art9#1',
  'eu261-art14#1',
  `${CAA_DELAYS}#1`,
  `${CAA_DELAYS}#2`,
  `${CAA_CANCEL}#2`,
  // procedures (UK CAA CAP 642; FAA AC; Airbus Safety First)
  'caa-cap642#23',
  'caa-cap642#27',
  'faa-ac-5210-20a#36',
  'airbus-lightning-strikes#1',
  'airbus-preventing-inadvertent-slide-deployments#1',
  'airbus-avoiding-fuel-spills-on-a320-family-aircraft#1',
  // precedents (NASA ASRS, de-identified, public domain)
  'asrs-1577181#1',
  'asrs-1326952#1',
  'asrs-1795954#1',
  'asrs-1827568#1',
  'asrs-1438905#1',
  'asrs-1750803#1',
  'asrs-1615772#1',
  'asrs-1671518#1',
];

async function main() {
  const all = new Map<string, ChunkRecord>();
  for (const f of readdirSync(RAW_DIR + 'chunks'))
    for (const c of parseChunks(readFileSync(`${RAW_DIR}chunks/${f}`, 'utf8'))) all.set(c.chunkId, c);
  const missing = FIXTURE_CHUNK_IDS.filter((id) => !all.has(id));
  if (missing.length) throw new Error(`missing chunks (run kb:build first): ${missing.join(', ')}`);
  const chunks = FIXTURE_CHUNK_IDS.map((id) => all.get(id)!);
  mkdirSync(FIXTURES, { recursive: true });
  writeFileSync(FIXTURES + 'corpus.jsonl', chunks.map((c) => JSON.stringify(c)).join('\n') + '\n');

  const embedder = await createEmbedder({ provider: 'local', cacheDir: process.env.KB_MODEL_CACHE });
  const vectors = await embedder!.embed(chunks.map((c) => indexText(c).slice(0, 2000)));
  const bySource = new Map<
    string,
    { sourceId: string; collection: ChunkRecord['collection']; chunks: number; licence: string }
  >();
  for (const c of chunks) {
    const s = bySource.get(c.sourceId) ?? {
      sourceId: c.sourceId,
      collection: c.collection,
      chunks: 0,
      licence: c.licence,
    };
    s.chunks++;
    bySource.set(c.sourceId, s);
  }
  const files = serialiseIndex(
    chunks,
    {
      builtAt: '2026-09-26T00:00:00.000Z',
      embeddings: { provider: 'local', model: embedder!.model, dim: embedder!.dim, quantisation: 'int8' },
      sources: [...bySource.values()],
      notes: [
        'Fixture mini-corpus for tests and CI (no network). Rebuild with `npm run kb:fixtures -w @ica/kb`.',
      ],
    },
    { vectors, dim: embedder!.dim },
  );
  const out = FIXTURES + 'index/';
  if (existsSync(out)) rmSync(out, { recursive: true });
  mkdirSync(out, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    if (name.endsWith('.json')) await writePrettyJson(out + name, JSON.parse(content as string));
    else writeFileSync(out + name, content);
  }
  // Query vectors for the retrieval tests, so hybrid search is tested without loading the model.
  const queries = [
    'APU inoperative dispatch',
    'flight duty period maximum sectors',
    'towbar shear pin pushback',
  ];
  const qv = await embedder!.embed(queries);
  await writePrettyJson(
    FIXTURES + 'query-vectors.json',
    Object.fromEntries(queries.map((q, i) => [q, Array.from(qv[i]).map((x) => Math.round(x * 1e5) / 1e5)])),
  );
  console.log(
    `wrote ${chunks.length} fixture chunks to ${FIXTURES} (${Object.keys(INDEX_FILES).length} index files)`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
