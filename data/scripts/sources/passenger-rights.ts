/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Passenger rights: Regulation (EC) No 261/2004 (EUR-Lex; re-use under Commission Decision 2011/833/EU), fetched
 * through the Publications Office cellar (EUR-Lex's HTML endpoint challenges scripted clients), and the UK CAA
 * passenger-rights pages (attribution to the UK Civil Aviation Authority). One chunk per EU 261 Article (with its
 * title) and per UK CAA page section (heading path).
 */
import { readFileSync } from 'node:fs';
import { articleChunks, sectionChunks, splitSections } from '../../src/chunking';
import type { ChunkRecord } from '../../src/format';
import { cleanText } from '../../src/text';
import { download, sleep } from '../lib';
import {
  htmlToMarkedText,
  htmlToText,
  markedHeadingLevel,
  markedHeadingText,
  slug,
  type SourceStep,
} from './types';

export const EU261_URL = 'https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32004R0261';
const EU261_CELLAR = 'http://publications.europa.eu/resource/celex/32004R0261';

export const CAA_PAGES = [
  'https://www.caa.co.uk/air-passengers/travel-problems-and-rights/flight-delays-and-cancellations/',
  'https://www.caa.co.uk/air-passengers/travel-problems-and-rights/flight-delays-and-cancellations/delays/',
  'https://www.caa.co.uk/air-passengers/travel-problems-and-rights/flight-delays-and-cancellations/cancellations/',
  'https://www.caa.co.uk/air-passengers/travel-problems-and-rights/travel-complaints/making-a-claim/am-i-entitled-to-compensation/',
];

const EU_LICENCE = '© European Union, EUR-Lex; re-use authorised under Commission Decision 2011/833/EU';
const CAA_LICENCE = '© UK Civil Aviation Authority; quoted with attribution';
const EU261_SOURCE = 'Regulation (EC) No 261/2004';

/** Split the EU 261 text into the recitals/preamble and its articles (`Article N` heading + title line). */
export function eu261Articles(text: string): {
  preamble: string;
  articles: { number: string; title: string; text: string }[];
} {
  const parts = text.split(/\n(?=Article \d+\s*\n)/);
  const articles: { number: string; title: string; text: string }[] = [];
  let preamble = '';
  for (const part of parts) {
    const m = part.match(/^Article (\d+)\s*\n+([^\n]+)/);
    if (m) articles.push({ number: m[1], title: m[2].trim(), text: part });
    else preamble += part;
  }
  return { preamble, articles };
}

export const eu261Step: SourceStep = {
  id: 'eu261',
  collection: 'passenger_rights',
  licence: EU_LICENCE,
  async run() {
    const path = await download(EU261_CELLAR, 'eu261.html', { accept: 'text/html', minBytes: 5000 });
    const text = htmlToText(readFileSync(path, 'utf8'));
    const { preamble, articles } = eu261Articles(text);
    const base = {
      url: EU261_URL,
      jurisdiction: 'EU' as const,
      date: '2004-02-11',
      collection: 'passenger_rights' as const,
      licence: EU_LICENCE,
    };
    const out: ChunkRecord[] = [];
    for (const a of articles) {
      const section = `Article ${a.number} — ${a.title}`;
      out.push(
        ...articleChunks(
          { ...base, sourceId: `EU Reg 261/2004 Art ${a.number}`, title: `${EU261_SOURCE} — ${section}` },
          a,
          { source: EU261_SOURCE, docPrefix: 'eu261' },
        ),
      );
    }
    out.push(
      ...sectionChunks(
        {
          ...base,
          sourceId: 'EU Reg 261/2004 preamble',
          title: `${EU261_SOURCE} — Recitals and preamble`,
        },
        [{ path: ['Recitals and preamble'], text: cleanText(preamble) }],
        { source: EU261_SOURCE, docPrefix: 'eu261-pre', maxChunks: 10 },
      ),
    );
    if (out.length < 5) throw new Error('EU 261/2004 text looks incomplete');
    return out;
  },
};

export const caaRightsStep: SourceStep = {
  id: 'caa-passenger-rights',
  collection: 'passenger_rights',
  licence: CAA_LICENCE,
  async run() {
    const out: ChunkRecord[] = [];
    for (const url of CAA_PAGES) {
      const name = slug(url.replace(/^https:\/\/www\.caa\.co\.uk\//, ''));
      const short = url.replace(/\/$/, '').split('/').pop()!;
      const path = await download(url, `caa/${name}.html`, { minBytes: 2000 });
      const html = readFileSync(path, 'utf8');
      const title = (html.match(/<title>([^<]+)<\/title>/i)?.[1] ?? name).replace(/\s*\|.*$/, '').trim();
      const sections = splitSections(htmlToMarkedText(html, 'main'), markedHeadingLevel, markedHeadingText)
        // The page title is already the source; drop a leading h1 that repeats it.
        .map((s) => ({ ...s, path: s.path.filter((p) => p && p !== title) }));
      out.push(
        ...sectionChunks(
          {
            sourceId: `UK CAA passenger rights: ${title}`,
            url,
            title: `UK CAA — ${title}`,
            jurisdiction: 'UK',
            collection: 'passenger_rights',
            licence: CAA_LICENCE,
            meta: { attribution: 'Source: UK Civil Aviation Authority (caa.co.uk).' },
          },
          sections,
          { source: `UK CAA — ${title}`, docPrefix: `caa-pr-${short}`, maxChunks: 12 },
        ),
      );
      await sleep(1000);
    }
    return out;
  },
};
