/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Ground-operations procedure stand-ins: FAA AC 150/5210-20A (public domain), UK CAA CAP 642 (CAA attribution),
 * Airbus Safety First ground-ops articles (reprint permitted with acknowledgement to Airbus), and — only with
 * KB_INCLUDE_FSF=true, for local use — a Flight Safety Foundation ramp template (redistribution unconfirmed).
 */
import { readFileSync } from 'node:fs';
import * as cheerio from 'cheerio';
import type { ChunkRecord } from '../../src/format';
import { cleanText } from '../../src/text';
import { download, sleep } from '../lib';
import { htmlToText, makeChunks, pdfPages, slug, type SourceStep } from './types';

export const FAA_AC_URL = 'https://www.faa.gov/documentLibrary/media/Advisory_Circular/150-5210-20A.pdf';
export const CAP642_URL = 'https://www.caa.co.uk/publication/download/12196';
const AIRBUS_LIST = 'https://safetyfirst.airbus.com/ground-ops/';
const AIRBUS_EXTRA = [
  'https://safetyfirst.airbus.com/lightning-strikes/',
  'https://safetyfirst.airbus.com/preventing-inadvertent-slide-deployments/',
  'https://safetyfirst.airbus.com/avoiding-fuel-spills-on-a320-family-aircraft/',
  'https://safetyfirst.airbus.com/safe-aircraft-parking/',
  'https://safetyfirst.airbus.com/safe-aircraft-refuelling/',
  'https://safetyfirst.airbus.com/preventing-violent-door-opening-due-to-residual-cabin-pressure/',
];
const AIRBUS_CAP = 14;
const AIRBUS_ACK =
  'Reprinted with acknowledgement to Airbus (Safety First magazine, safetyfirst.airbus.com).';

async function pdfChunks(
  url: string,
  file: string,
  base: Omit<ChunkRecord, 'chunkId' | 'text'>,
  prefix: string,
  skipPages = 0,
): Promise<ChunkRecord[]> {
  const path = await download(url, file, { minBytes: 10_000 });
  const pages = (await pdfPages(path)).slice(skipPages);
  return makeChunks(base, cleanText(pages.join('\n\n')), { idPrefix: prefix, maxChunks: 200 });
}

export const faaAcStep: SourceStep = {
  id: 'faa-ac-150-5210-20a',
  collection: 'procedure',
  licence: 'Public domain (US Government work, FAA Advisory Circular)',
  run: () =>
    pdfChunks(
      FAA_AC_URL,
      'faa-ac-150-5210-20a.pdf',
      {
        sourceId: 'FAA AC 150/5210-20A',
        url: FAA_AC_URL,
        title:
          'FAA AC 150/5210-20A Ground Vehicle Operations to include Taxiing or Towing an Aircraft on Airports',
        jurisdiction: 'US',
        collection: 'procedure',
        licence: 'Public domain (US Government work, FAA Advisory Circular)',
      },
      'faa-ac-5210-20a',
    ),
};

export const cap642Step: SourceStep = {
  id: 'caa-cap642',
  collection: 'procedure',
  licence: '© UK Civil Aviation Authority; quoted with attribution (CAP 642 Airside Safety Management)',
  run: () =>
    pdfChunks(
      CAP642_URL,
      'caa-cap642.pdf',
      {
        sourceId: 'UK CAA CAP 642',
        url: CAP642_URL,
        title: 'UK CAA CAP 642 Airside Safety Management',
        jurisdiction: 'UK',
        collection: 'procedure',
        licence: '© UK Civil Aviation Authority; quoted with attribution (CAP 642 Airside Safety Management)',
        meta: { attribution: 'Source: UK Civil Aviation Authority, CAP 642 Airside Safety Management.' },
      },
      'caa-cap642',
      2,
    ),
};

export const airbusStep: SourceStep = {
  id: 'airbus-safety-first',
  collection: 'procedure',
  licence: 'Airbus Safety First: articles may be reprinted without permission with acknowledgement to Airbus',
  async run() {
    const listPath = await download(AIRBUS_LIST, 'airbus/ground-ops.html');
    const $ = cheerio.load(readFileSync(listPath, 'utf8'));
    const links = new Set<string>(AIRBUS_EXTRA);
    const skip =
      /\/(about|archive|feed|magazine|cabin-ops|flight-ops|ground-ops|maintenance|privacy[^/]*)\/$/;
    $('a[href^="https://safetyfirst.airbus.com/"]').each((_, a) => {
      const href = $(a).attr('href')!;
      if (/^https:\/\/safetyfirst\.airbus\.com\/[a-z0-9-]+\/$/.test(href) && !skip.test(href))
        links.add(href);
    });
    const out: ChunkRecord[] = [];
    for (const url of [...links].slice(0, AIRBUS_CAP)) {
      const name = slug(url.replace(/^https:\/\/safetyfirst\.airbus\.com\//, ''));
      try {
        const path = await download(url, `airbus/${name}.html`);
        const html = readFileSync(path, 'utf8');
        const $a = cheerio.load(html);
        const title = ($a('h1').first().text().trim() || $a('title').text().trim()).replace(
          /\s*[–-]\s*Safety First$/,
          '',
        );
        // Article bodies are rendered client-side; the full article is published as a PDF alongside.
        const pdfHref = html.match(/href="(https:\/\/mms-safetyfirst\.[^"]+\.pdf)"/)?.[1];
        let body: string;
        if (pdfHref) {
          const pdfPath = await download(pdfHref, `airbus/${name}.pdf`, { minBytes: 5000 });
          body = cleanText((await pdfPages(pdfPath)).join('\n\n'));
        } else body = htmlToText(html, 'body');
        if (body.length < 1500) continue;
        if (/copyright/i.test(body.slice(0, 400))) continue; // third-party copyright indicated: skip
        out.push(
          ...makeChunks(
            {
              sourceId: `Airbus Safety First: ${title}`.slice(0, 120),
              url,
              title: `Airbus Safety First — ${title}`,
              collection: 'procedure',
              licence: airbusStep.licence,
              meta: { attribution: AIRBUS_ACK },
            },
            body,
            { idPrefix: `airbus-${name}`, maxChunks: 12 },
          ),
        );
      } catch (err) {
        console.warn(`  ! airbus ${url}: ${String(err)}`);
      }
      await sleep(1000);
    }
    if (!out.length) throw new Error('no Airbus Safety First articles extracted');
    return out;
  },
};

export const fsfStep: SourceStep = {
  id: 'fsf-ramp-template',
  collection: 'procedure',
  licence: 'Flight Safety Foundation — redistribution unconfirmed; LOCAL USE ONLY (KB_INCLUDE_FSF=true)',
  enabled: () => process.env.KB_INCLUDE_FSF === 'true',
  async run() {
    const url = process.env.KB_FSF_URL;
    if (!url)
      throw new Error('KB_INCLUDE_FSF=true needs KB_FSF_URL (a PDF of the FSF ramp procedures template)');
    return pdfChunks(
      url,
      'fsf-ramp-template.pdf',
      {
        sourceId: 'FSF ramp procedures template',
        url,
        title: 'Flight Safety Foundation ground accident prevention — ramp operational procedures template',
        collection: 'procedure',
        licence: fsfStep.licence,
      },
      'fsf-ramp',
    );
  },
};
