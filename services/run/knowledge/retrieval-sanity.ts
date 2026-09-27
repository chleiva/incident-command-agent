/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Offline retrieval sanity eval: a dozen hand-written queries with expected documents, run against the real built
 * index (`data/index/`, Cohere build, vectors searched in memory from `vectors/`) in three modes — BM25 only, hybrid
 * (BM25 + Cohere Embed v4), hybrid + Cohere Rerank 3.5 — reporting hit@3 and MRR@10.
 *
 *   npx tsx services/run/knowledge/retrieval-sanity.ts [--index data/index] [--out data/index/retrieval-sanity.json]
 *     [--pace-ms 21000]   (space the rerank queries under a 3 requests/minute Rerank 3.5 quota)
 *
 * LIVE: makes ~24 Bedrock embedding calls and 12 rerank calls (≈ USD 0.03). Not part of `npm test`.
 */
import { writeFileSync } from 'node:fs';
import { cohereEmbedder } from '@ica/kb';
import type { KnowledgeCollection, KnowledgeHit, Jurisdiction } from '@ica/schema';
import { DEFAULT_INDEX_DIR, loadKnowledgeIndex, type LoadedKnowledgeIndex } from './index';
import { cohereReranker } from './rerank';

export interface SanityCase {
  query: string;
  collections?: KnowledgeCollection[];
  jurisdiction?: Jurisdiction;
  /** A hit is relevant when its docId starts with one of these prefixes or its header contains one of `headers`. */
  docPrefixes?: string[];
  headers?: string[];
}

export const SANITY_CASES: SanityCase[] = [
  { query: 'MEL 49-10-01 APU', collections: ['mel'], docPrefixes: ['mmel-49-10-01'] },
  // Any ATA 49 (APU) MMEL item is relevant.
  { query: 'APU inoperative dispatch conditions', collections: ['mel'], docPrefixes: ['mmel-49-'] },
  {
    query: "commander's discretion FDP extension",
    collections: ['rules'],
    docPrefixes: ['easa-ORO.FTL.205-f', 'easa-AMC1-ORO.FTL.205-f', 'easa-GM1-ORO.FTL.205-f'],
  },
  {
    query: 'maximum daily FDP acclimatised crew by number of sectors',
    collections: ['rules'],
    docPrefixes: ['easa-ORO.FTL.205-b'],
  },
  {
    query: 'operator procedures to rectify defects deferred under the MEL',
    collections: ['rules'],
    docPrefixes: ['easa-ORO.MLR.105', 'easa-AMC1-ORO.MLR.105', 'easa-GM1-ORO.MLR.105'],
  },
  { query: 'EU261 Article 14 information', collections: ['passenger_rights'], docPrefixes: ['eu261-art14'] },
  {
    query: 'meals refreshments and hotel accommodation for delayed passengers',
    collections: ['passenger_rights'],
    jurisdiction: 'EU',
    docPrefixes: ['eu261-art9', 'eu261-art6'],
  },
  {
    query: 'how much compensation 250 400 600 euro by flight distance',
    collections: ['passenger_rights'],
    jurisdiction: 'EU',
    docPrefixes: ['eu261-art7'],
  },
  {
    query: 'UK passengers delay compensation extraordinary circumstances',
    collections: ['passenger_rights'],
    jurisdiction: 'UK',
    docPrefixes: ['caa-pr-am-i-entitled-to-compensation', 'caa-pr-delays'],
  },
  // Any precedent whose synopsis reports a sheared tow bar pin is relevant (many ASRS/AAIB reports do).
  {
    query: 'towbar shear pin pushback',
    collections: ['precedent'],
    headers: ['shear pin', 'towbar pin', 'tow bar pin'],
  },
  {
    query: 'inspecting the aircraft after a lightning strike',
    collections: ['procedure'],
    docPrefixes: ['airbus-lightning-strikes'],
  },
  {
    query: 'escape slide inadvertent deployment when opening the door',
    collections: ['procedure'],
    docPrefixes: ['airbus-preventing-inadvertent-slide-deployments'],
  },
  {
    query: 'multiple pushbacks from adjacent stands at the same time',
    collections: ['procedure'],
    headers: ['Multiple pushback procedures'],
  },
];

export const isRelevant = (c: SanityCase, h: Pick<KnowledgeHit, 'docId' | 'chunkId' | 'header'>) =>
  (c.docPrefixes ?? []).some((p) => (h.docId ?? h.chunkId).startsWith(p)) ||
  (c.headers ?? []).some((x) => h.header?.toLowerCase().includes(x.toLowerCase()));

/** hit@k and MRR@k over ranked hits per case. */
export function score(
  cases: SanityCase[],
  ranked: Pick<KnowledgeHit, 'docId' | 'chunkId' | 'header'>[][],
  k = 3,
) {
  let hits = 0;
  let rr = 0;
  const ranks: (number | null)[] = [];
  cases.forEach((c, i) => {
    const r = ranked[i].findIndex((h) => isRelevant(c, h));
    ranks.push(r >= 0 ? r + 1 : null);
    if (r >= 0 && r < k) hits++;
    if (r >= 0) rr += 1 / (r + 1);
  });
  return { hitAtK: hits / cases.length, mrr: rr / cases.length, ranks };
}

async function run(idx: LoadedKnowledgeIndex, cases: SanityCase[], paceMs = 0) {
  const out: KnowledgeHit[][] = [];
  const ms: number[] = [];
  const modes: string[] = [];
  for (const [i, c] of cases.entries()) {
    if (paceMs && i > 0) await new Promise((r) => setTimeout(r, paceMs));
    const t0 = Date.now();
    out.push(
      await idx.search({ query: c.query, collections: c.collections, jurisdiction: c.jurisdiction, k: 10 }),
    );
    ms.push(Date.now() - t0);
    modes.push(idx.lastTrace()?.mode ?? 'bm25');
  }
  return { out, ms, modes };
}

async function main() {
  const arg = (n: string) => {
    const i = process.argv.indexOf(`--${n}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const path = arg('index') ?? DEFAULT_INDEX_DIR;
  const env = {
    KB_VECTOR_STORE: 'memory',
    KB_EMBED_TIMEOUT_MS: '8000',
    KB_VECTOR_TIMEOUT_MS: '15000',
    KB_RERANK_TIMEOUT_MS: '8000',
  };
  const cohere = cohereEmbedder({ region: process.env.KB_EMBED_REGION ?? 'eu-west-2' });
  // One embedding per query across the two hybrid indexes (stays under the 20 requests/minute quota).
  const memo = new Map<string, Float32Array>();
  const embedder = {
    dim: cohere.dim,
    model: cohere.model,
    usage: cohere.usage,
    async embed(texts: string[], o?: Parameters<typeof cohere.embed>[1]) {
      const key = texts.join('\u0000');
      if (!memo.has(key)) memo.set(key, (await cohere.embed(texts, o))[0]);
      return [memo.get(key)!];
    },
  };
  const bm25 = await loadKnowledgeIndex({ source: 'fs', path, embeddings: 'none', noCache: true });
  const hybrid = await loadKnowledgeIndex({
    source: 'fs',
    path,
    env,
    embedder,
    reranker: null,
    noCache: true,
  });
  const reranked = await loadKnowledgeIndex({
    source: 'fs',
    path,
    env,
    embedder,
    reranker: cohereReranker({ region: process.env.KB_RERANK_REGION ?? 'eu-central-1' }),
    noCache: true,
  });
  const results: Record<
    string,
    ReturnType<typeof score> & { ms: number[]; modes: string[]; top3: string[][] }
  > = {};
  for (const [name, idx] of [
    ['bm25', bm25],
    ['hybrid', hybrid],
    ['hybrid+rerank', reranked],
  ] as const) {
    // The account's Cohere Rerank 3.5 quota is 3 requests/minute by default: pace the rerank run (--pace-ms 21000).
    const r = await run(idx, SANITY_CASES, name === 'hybrid+rerank' ? Number(arg('pace-ms') ?? 0) : 0);
    results[name] = {
      ...score(SANITY_CASES, r.out),
      ms: r.ms,
      modes: r.modes,
      top3: r.out.map((hs) => hs.slice(0, 3).map((h) => h.docId ?? h.chunkId)),
    };
  }
  console.log('\nquery'.padEnd(62) + 'bm25  hybrid  +rerank   (rank of first relevant doc, top 10)');
  SANITY_CASES.forEach((c, i) => {
    const f = (n: string) => String(results[n].ranks[i] ?? '–').padEnd(8);
    console.log(`${c.query.slice(0, 60).padEnd(61)} ${f('bm25')}${f('hybrid')}${f('hybrid+rerank')}`);
  });
  for (const [n, r] of Object.entries(results))
    console.log(
      `${n.padEnd(14)} hit@3 ${(r.hitAtK * 100).toFixed(0)}%  MRR ${r.mrr.toFixed(3)}  median ${[...r.ms].sort((a, b) => a - b)[r.ms.length >> 1]} ms  modes ${[...new Set(r.modes)].join(',')}`,
    );
  console.log(`cohere embed usage: ${JSON.stringify(embedder.usage)}`);
  const out = arg('out');
  if (out)
    writeFileSync(out, JSON.stringify({ cases: SANITY_CASES, results, embedUsage: embedder.usage }, null, 2));
}

if (process.argv[1]?.endsWith('retrieval-sanity.ts'))
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
