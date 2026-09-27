/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * UK AAIB reports (Open Government Licence v3.0) through the GOV.UK search and content APIs. Polite: one request
 * per second, a descriptive user agent, and a hard cap of ~150 ground-event reports. One report = one docId; the
 * bulletin text (running headers stripped) is split into ~800-token parts with the report header repeated.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { reportChunks } from '../../src/chunking';
import type { ChunkRecord } from '../../src/format';
import { stripRepeatedLines } from '../../src/text';
import { RAW_DIR, USER_AGENT, download, sleep } from '../lib';
import { htmlToText, pdfPages, type SourceStep } from './types';

const CAP = Number(process.env.KB_AAIB_CAP ?? 150);
const DELAY_MS = 1000;
/** Parts kept per report (~800 tokens each). */
const MAX_PARTS = 10;
const QUERIES = [
  'pushback',
  'towbar',
  'tug collided',
  'ground collision stand',
  'catering vehicle',
  'ground handling vehicle',
  'baggage loader',
  'passenger steps',
  'airbridge',
  'escape slide deployed',
  'cargo door',
  'bird strike',
  'lightning strike',
  'hydraulic leak',
  'fuel spill',
  'brake fire',
  'APU fire',
  'refuelling',
  'on stand',
  'ramp',
];

interface SearchResult {
  title: string;
  link: string;
  description?: string;
  date_of_occurrence?: string;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return (await res.json()) as T;
}

export const aaibStep: SourceStep = {
  id: 'aaib',
  collection: 'precedent',
  licence: 'Open Government Licence v3.0 (UK AAIB, Crown copyright)',
  async run() {
    const found = new Map<string, SearchResult>();
    for (const q of QUERIES) {
      if (found.size >= CAP) break;
      const url =
        'https://www.gov.uk/api/search.json?filter_format=aaib_report' +
        '&filter_aircraft_category=commercial-fixed-wing&count=25' +
        '&fields=title,link,description,date_of_occurrence&q=' +
        encodeURIComponent(q);
      const res = await getJson<{ results: SearchResult[] }>(url);
      for (const r of res.results) if (found.size < CAP && !found.has(r.link)) found.set(r.link, r);
      await sleep(DELAY_MS);
    }
    const out: ChunkRecord[] = [];
    mkdirSync(RAW_DIR + 'aaib', { recursive: true });
    for (const raw of found.values()) {
      const r = {
        ...raw,
        title: raw.title.replace(/\s+/g, ' ').trim(),
        description: raw.description?.replace(/\s+/g, ' ').trim(),
      };
      const slug = r.link.split('/').pop()!;
      const cacheFile = `${RAW_DIR}aaib/${slug}.json`;
      let content: {
        details: { body?: string; attachments?: { title?: string; url: string; content_type?: string }[] };
      };
      if (existsSync(cacheFile)) content = JSON.parse(readFileSync(cacheFile, 'utf8'));
      else {
        content = await getJson(`https://www.gov.uk/api/content${r.link}`);
        writeFileSync(cacheFile, JSON.stringify(content));
        await sleep(DELAY_MS);
      }
      const summary = htmlToText(content.details.body ?? '').replace(
        /Download (the report|glossary)[^\n]*\n?/gi,
        '',
      );
      let pdfText = '';
      const att = (content.details.attachments ?? []).find(
        (a) => /pdf/i.test(a.content_type ?? a.url) && !/glossary/i.test(a.title ?? ''),
      );
      if (att) {
        try {
          const pdfPath = await download(att.url, `aaib/${slug}.pdf`, { minBytes: 1000 });
          pdfText = stripRepeatedLines(await pdfPages(pdfPath), { minShare: 0.5 }).join('\n\n');
          await sleep(DELAY_MS);
        } catch (err) {
          console.warn(`  ! aaib ${slug}: pdf failed (${String(err)})`);
        }
      }
      const url = `https://www.gov.uk${r.link}`;
      const text = [r.description && `Summary: ${r.description}`, summary, pdfText]
        .filter(Boolean)
        .join('\n\n');
      const name = r.title.replace(/^AAIB investigation to /i, '');
      out.push(
        ...reportChunks(
          {
            sourceId: `AAIB ${name}`.slice(0, 120),
            url,
            title: `${r.title}${r.description ? ` — ${r.description}` : ''}`.slice(0, 200),
            jurisdiction: 'UK',
            date: r.date_of_occurrence,
            collection: 'precedent',
            licence: aaibStep.licence,
            meta: {
              attribution:
                'Contains public sector information licensed under the Open Government Licence v3.0.',
            },
          },
          {
            docId: `aaib-${slug.replace(/^aaib-investigation-to-/, '')}`,
            reportId: `AAIB report: ${name}`,
            synopsis: r.description,
            aircraftType: name.split(',')[0]?.trim() || undefined,
            text,
          },
          { maxParts: MAX_PARTS },
        ),
      );
    }
    return out;
  },
};
