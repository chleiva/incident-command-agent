/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Passenger rights: Regulation (EC) No 261/2004 (EUR-Lex; re-use under Commission Decision 2011/833/EU), fetched
 * through the Publications Office cellar (EUR-Lex's HTML endpoint challenges scripted clients), and the UK CAA
 * passenger-rights pages (attribution to the UK Civil Aviation Authority).
 */
import { readFileSync } from 'node:fs';
import type { ChunkRecord } from '../../src/format';
import { cleanText } from '../../src/text';
import { download, sleep } from '../lib';
import { htmlToText, makeChunks, slug, type SourceStep } from './types';

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

export const eu261Step: SourceStep = {
  id: 'eu261',
  collection: 'passenger_rights',
  licence: EU_LICENCE,
  async run() {
    const path = await download(EU261_CELLAR, 'eu261.html', { accept: 'text/html', minBytes: 5000 });
    const text = htmlToText(readFileSync(path, 'utf8'));
    // Split on "Article N" headings so each chunk carries its article number.
    const parts = text.split(/\n(?=Article \d+\s*\n)/);
    const out: ChunkRecord[] = [];
    for (const part of parts) {
      const m = part.match(/^Article (\d+)\s*\n+([^\n]+)/);
      const section = m ? `Article ${m[1]} — ${m[2].trim()}` : 'Recitals and preamble';
      out.push(
        ...makeChunks(
          {
            sourceId: m ? `EU Reg 261/2004 Art ${m[1]}` : 'EU Reg 261/2004 preamble',
            url: EU261_URL,
            title: `Regulation (EC) No 261/2004 — ${section}`,
            section,
            jurisdiction: 'EU',
            date: '2004-02-11',
            collection: 'passenger_rights',
            licence: EU_LICENCE,
          },
          cleanText(part),
          { idPrefix: `eu261-${m ? `art${m[1]}` : 'pre'}`, maxChunks: 10 },
        ),
      );
    }
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
      const path = await download(url, `caa/${name}.html`, { minBytes: 2000 });
      const html = readFileSync(path, 'utf8');
      const title = (html.match(/<title>([^<]+)<\/title>/i)?.[1] ?? name).replace(/\s*\|.*$/, '').trim();
      out.push(
        ...makeChunks(
          {
            sourceId: `UK CAA passenger rights: ${title}`,
            url,
            title: `UK CAA — ${title}`,
            jurisdiction: 'UK',
            collection: 'passenger_rights',
            licence: CAA_LICENCE,
            meta: { attribution: 'Source: UK Civil Aviation Authority (caa.co.uk).' },
          },
          htmlToText(html, 'main'),
          { idPrefix: `caa-${name}`, maxChunks: 8 },
        ),
      );
      await sleep(1000);
    }
    return out;
  },
};
