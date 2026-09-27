/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * NASA ASRS narratives via the Hugging Face dataset `elihoole/asrs-aviation-reports` (parquet through the HF
 * datasets server; 47,723 reports). Filtered to air-carrier ground, pre-departure and maintenance-relevant reports by
 * a keyword/flight-phase relevance score, highest first, capped at KB_ASRS_CAP (default 15,000). One report = one
 * chunk up to ~1,000 tokens (longer reports split, header repeated); docId = `asrs-<ACN>`.
 */
import { readFileSync } from 'node:fs';
import { parquetReadObjects } from 'hyparquet';
import { reportChunks } from '../../src/chunking';
import type { ChunkRecord } from '../../src/format';
import { download } from '../lib';
import type { SourceStep } from './types';

export const ASRS_DATASET_URL = 'https://huggingface.co/datasets/elihoole/asrs-aviation-reports';
export const ASRS_DISCLAIMER =
  'ASRS reports are submitted voluntarily and are not verified by NASA; they may be incomplete or inaccurate ' +
  'and must not be used to infer the frequency of any event.';

const PARQUET_INDEX = 'https://datasets-server.huggingface.co/parquet?dataset=elihoole/asrs-aviation-reports';
const CAP = Number(process.env.KB_ASRS_CAP ?? 15000);
/** Minimum relevance score (a single ground keyword, e.g. "gate" or "door", scores 1; a ground flight phase 3). */
const MIN_SCORE = Number(process.env.KB_ASRS_MIN_SCORE ?? 1);
/** Parts kept per report (p99 report ≈ 1,850 tokens → ≤ 3 parts of ~800). */
const MAX_PARTS = 3;

/** Relevance keywords (weights). Widened from the first build: GSE, ground power, de-icing rigs, maintenance write-ups. */
export const ASRS_KEYWORDS: [RegExp, number][] = [
  [/\bpush ?back|\btug\b|towbar|tow bar|\btowing\b|tow ?(?:truck|tractor)/i, 3],
  [
    /catering|\bgse\b|belt loader|baggage (?:cart|tug|loader)|fuel (?:truck|truk)|fueler|lav(?:atory)? (?:truck|service)|jet ?bridge|jetway|air ?stair|ground power|\bgpu\b|de-?ic(?:e|ing) (?:truck|rig)/i,
    3,
  ],
  [/bird ?strike|\bbird\b/i, 2],
  [/lightning/i, 3],
  [/cargo door|service door|passenger door|door warning|\bdoor\b/i, 1],
  [/\bslide\b|escape slide|inadvertent(?:ly)? deploy/i, 3],
  [/hydraulic (?:leak|fluid)/i, 3],
  [/fuel spill|fuel leak|refuel/i, 3],
  [/brake (?:temp|overheat|fire)|hot brake/i, 3],
  [/\bapu\b/i, 2],
  [/\bmel\b|deferr?al|deferred|placard|logbook|write-?up|maintenance (?:control|release)|mechanic/i, 2],
  [/\bstand\b|\bgate\b|\bramp\b|marshal|wing ?walker|chock|ground crew|ramp agent/i, 1],
  [/duty time|flight duty|\bfdp\b|crew rest|timed out|time out/i, 2],
  [/weight and balance|load ?sheet|load plan|hazmat|dangerous goods/i, 1],
];

const GROUND_PHASES = /parked|taxi|pushback|tow|ramp|gate|boarding|preflight|ground/i;

export function asrsRelevance(r: Record<string, unknown>): number {
  const text = `${r['Report 1.2_Synopsis'] ?? ''} ${r['Report 1_Narrative'] ?? ''}`;
  let score = 0;
  for (const [re, w] of ASRS_KEYWORDS) if (re.test(text)) score += w;
  if (GROUND_PHASES.test(String(r['Aircraft 1.9_Flight Phase'] ?? ''))) score += 3;
  if (String(r['Aircraft 1.12_Maintenance Status.Maintenance Deferred'] ?? '').length) score += 1;
  return score;
}

export const asrsStep: SourceStep = {
  id: 'asrs',
  collection: 'precedent',
  licence: 'Public domain (US Government work, NASA ASRS); reports unverified, NASA disclaimer applies',
  async run() {
    const idxRes = await fetch(PARQUET_INDEX);
    if (!idxRes.ok) throw new Error(`datasets server HTTP ${idxRes.status}`);
    const idx = (await idxRes.json()) as { parquet_files: { split: string; url: string }[] };
    const columns = [
      'acn_num_ACN',
      'Time_Date',
      'Place_Locale Reference',
      'Aircraft 1.1_Aircraft Operator',
      'Aircraft 1.2_Make Model Name',
      'Aircraft 1.9_Flight Phase',
      'Aircraft 1.12_Maintenance Status.Maintenance Deferred',
      'Events_Anomaly',
      'Report 1_Narrative',
      'Report 2_Narrative',
      'Report 1.2_Synopsis',
    ];
    const candidates: { score: number; row: Record<string, unknown> }[] = [];
    for (const f of idx.parquet_files) {
      const path = await download(f.url, `asrs/${f.split}.parquet`, { minBytes: 1000, timeoutMs: 600_000 });
      const buf = readFileSync(path);
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      const rows = (await parquetReadObjects({
        file: { byteLength: ab.byteLength, slice: (s: number, e?: number) => ab.slice(s, e) },
        columns,
      })) as Record<string, unknown>[];
      for (const row of rows) {
        const op = String(row['Aircraft 1.1_Aircraft Operator'] ?? '');
        if (!/air carrier/i.test(op)) continue;
        if (!row['Report 1_Narrative']) continue;
        const score = asrsRelevance(row);
        if (score >= MIN_SCORE) candidates.push({ score, row });
      }
    }
    candidates.sort(
      (a, b) => b.score - a.score || String(a.row.acn_num_ACN).localeCompare(String(b.row.acn_num_ACN)),
    );
    const seen = new Set<string>();
    const out: ChunkRecord[] = [];
    for (const { row } of candidates) {
      if (seen.size >= CAP) break;
      const acn = String(row.acn_num_ACN ?? '').replace(/\.0$/, '');
      if (!/^\d+$/.test(acn) || seen.has(acn)) continue;
      seen.add(acn);
      const synopsis = String(row['Report 1.2_Synopsis'] ?? '').trim();
      const d = String(row.Time_Date ?? '');
      const date = /^\d{6}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}` : undefined;
      const text = [
        `Narrative: ${String(row['Report 1_Narrative']).trim()}`,
        row['Report 2_Narrative'] ? `Second narrative: ${String(row['Report 2_Narrative']).trim()}` : '',
      ]
        .filter(Boolean)
        .join('\n\n');
      const phase = String(row['Aircraft 1.9_Flight Phase'] ?? '').trim();
      const anomalies = String(row['Events_Anomaly'] ?? '').trim();
      out.push(
        ...reportChunks(
          {
            sourceId: `ASRS ACN ${acn}`,
            url: ASRS_DATASET_URL,
            title: `ASRS ACN ${acn}: ${synopsis.slice(0, 90) || 'narrative'}`,
            // Phase only: the anomalies are in the context header (keeps the Lambda-loaded index small).
            section: phase.slice(0, 60) || undefined,
            jurisdiction: 'US',
            date,
            collection: 'precedent',
            licence: asrsStep.licence,
            meta: { disclaimer: ASRS_DISCLAIMER },
          },
          {
            docId: `asrs-${acn}`,
            reportId: `ASRS ACN ${acn}`,
            synopsis,
            aircraftType: String(row['Aircraft 1.2_Make Model Name'] ?? '').trim() || undefined,
            phase: phase || undefined,
            eventType: anomalies
              ? anomalies
                  .split(';')
                  .map((a) => a.trim())
                  .filter(Boolean)
                  .slice(0, 3)
                  .join('; ')
              : undefined,
            text,
          },
          { maxParts: MAX_PARTS },
        ),
      );
    }
    return out;
  },
};
