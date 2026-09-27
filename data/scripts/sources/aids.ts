/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * FAA Accident and Incident Data System (supplementary, public domain). The ASIAS download page is an interactive
 * APEX application; this step looks for a direct tab-delimited/CSV export link (or uses KB_AIDS_URL) and fails
 * gracefully otherwise — the build continues without it.
 */
import { readFileSync } from 'node:fs';
import { parse } from 'csv-parse/sync';
import type { ChunkRecord } from '../../src/format';
import { USER_AGENT, download } from '../lib';
import { reportChunks } from '../../src/chunking';
import type { SourceStep } from './types';

const PAGE = 'https://www.asias.faa.gov/apex/f?p=100:189:::NO';
const CAP = 500;

export const aidsStep: SourceStep = {
  id: 'aids',
  collection: 'precedent',
  licence: 'Public domain (US Government work, FAA AIDS)',
  async run() {
    let url = process.env.KB_AIDS_URL;
    if (!url) {
      const res = await fetch(PAGE, {
        headers: { 'user-agent': USER_AGENT },
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok)
        throw new Error(`ASIAS AIDS page HTTP ${res.status} (set KB_AIDS_URL to a .csv/.txt export)`);
      const html = await res.text();
      const m = html.match(/href="([^"]+\.(?:csv|txt))"/i);
      if (!m) throw new Error('no direct AIDS export link found (set KB_AIDS_URL to a .csv/.txt export)');
      url = new URL(m[1], PAGE).toString();
    }
    const path = await download(url, 'aids/aids-export.txt', { minBytes: 100 });
    const text = readFileSync(path, 'utf8');
    const delimiter = text.split('\n')[0].includes('\t') ? '\t' : ',';
    const rows = parse(text, {
      columns: true,
      delimiter,
      relax_column_count: true,
      skip_empty_lines: true,
    }) as Record<string, string>[];
    const out: ChunkRecord[] = [];
    for (const r of rows) {
      if (out.length >= CAP) break;
      const narrative = Object.entries(r)
        .filter(([k, v]) => /remark|narr|description/i.test(k) && v)
        .map(([, v]) => v)
        .join('\n');
      if (!/tug|tow|push|gate|ramp|catering|ground/i.test(narrative)) continue;
      const id = r['AIDS Report Number'] || r['c5'] || String(out.length + 1);
      out.push(
        ...reportChunks(
          {
            sourceId: `FAA AIDS ${id}`,
            url: 'https://www.asias.faa.gov/',
            title: `FAA AIDS ${id}`,
            jurisdiction: 'US',
            collection: 'precedent',
            licence: aidsStep.licence,
          },
          { docId: `aids-${id}`, reportId: `FAA AIDS ${id}`, text: narrative },
          { maxParts: 1 },
        ),
      );
    }
    return out;
  },
};
