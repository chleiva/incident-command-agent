/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Ground-operations procedure stand-ins: FAA AC 150/5210-20A (public domain), UK CAA CAP 642 (CAA attribution),
 * Airbus Safety First ground-ops articles (reprint permitted with acknowledgement to Airbus), and — only with
 * KB_INCLUDE_FSF=true, for local use — a Flight Safety Foundation ramp template (redistribution unconfirmed).
 *
 * Heading-aware chunking: running page headers/footers and repeated disclaimers are stripped, the text is split at
 * the document's own headings (numbered AC paragraphs, CAP 642 contents entries, Airbus capitalised headings), and
 * each section is packed to 300–600 tokens with ~15% overlap inside long prose, under a breadcrumb header.
 */
import { readFileSync } from 'node:fs';
import * as cheerio from 'cheerio';
import { sectionChunks, splitSections, type Section } from '../../src/chunking';
import type { ChunkRecord } from '../../src/format';
import { stripRepeatedLines } from '../../src/text';
import { download, sleep } from '../lib';
import { htmlToText, pdfPages, slug, type SourceStep } from './types';

const TOC_LINE = /\.{5,}/;

/** FAA AC headings: `CHAPTER 3. TITLE` / `APPENDIX A. TITLE` (1), `3.2 Title.` / `A.1 Title.` (2), `3.2.1 Title.` (3). */
export function faaAcHeadingLevel(line: string): number {
  if (TOC_LINE.test(line)) return 0;
  if (/^(CHAPTER \d+|APPENDIX [A-Z])\. [A-Z][A-Z ,/&()-]+$/.test(line)) return 1;
  const m = line.match(/^(\d+(?:\.\d+){0,2}|[A-Z](?:\.\d+){1,2})\s+([A-Z][^]{2,100})\.$/);
  if (!m || /\.\s/.test(m[2])) return 0;
  const depth = m[1].split('.').length;
  return /^\d+$/.test(m[1]) ? 2 : Math.min(3, depth);
}

const isCapTocPage = (p: string) => /^Contents$|^CAP 642 Contents$/m.test(p);

/** CAP 642: headings are the entries of its own table of contents (chapters level 1, entries level 2). */
export function cap642Headings(pages: string[]): { titles: Set<string>; chapters: Map<string, string> } {
  const titles = new Set<string>();
  const chapters = new Map<string, string>();
  const toc = pages.filter(isCapTocPage).flatMap((p) => p.split('\n'));
  for (let i = 0; i < toc.length; i++) {
    const m = toc[i].trim().match(/^(.+?)\s+(\d{1,3})$/);
    const chap = toc[i].trim().match(/^(Chapter \d+|Appendix \w+)(?:\s+\d{1,3})?$/);
    if (chap) {
      const next = toc[i + 1]?.trim().match(/^(.+?)\s+(\d{1,3})$/);
      if (next) chapters.set(chap[1], next[1]);
      continue;
    }
    if (m && m[1].length > 3 && !/^CAP 642|^November/.test(m[1])) titles.add(m[1]);
  }
  return { titles, chapters };
}

/** Airbus Safety First articles: ALL-CAPS lines are level-1 headings, short title-case lines between paragraphs level 2. */
export function airbusHeadingLevel(line: string, prev: string, next: string): number {
  if (/[.:;,!?]$/.test(line) || /^[(\d•●-]/.test(line) || line.length > 80) return 0;
  const letters = line.replace(/[^A-Za-z]/g, '');
  const words = line.split(/\s+/);
  if (
    letters.length >= 8 &&
    letters === letters.toUpperCase() &&
    words.length >= 2 &&
    words.length <= 10 &&
    new Set(words).size === words.length &&
    !/\d|\.{3,}/.test(line)
  )
    return 1;
  if (
    line.split(/\s+/).length <= 7 &&
    /^[A-Z]/.test(line) &&
    /[.:!?]$/.test(prev) &&
    /^[A-Z]/.test(next) &&
    next.length > 40
  )
    return 2;
  return 0;
}

const AIRBUS_DROP = [/^Check the latest version of this article/i, /^Safety first\s*[-–].*Page \d+\/\d+$/i];

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

export const faaAcStep: SourceStep = {
  id: 'faa-ac-150-5210-20a',
  collection: 'procedure',
  licence: 'Public domain (US Government work, FAA Advisory Circular)',
  async run() {
    const path = await download(FAA_AC_URL, 'faa-ac-150-5210-20a.pdf', { minBytes: 10_000 });
    const pages = stripRepeatedLines(await pdfPages(path), {
      drop: [/^This Page Intentionally Blank\.?$/i, /^[A-C]?-?\d{1,2}-\d{1,2}$/, /^[ivx]+$/i],
    }).filter((p) => !TOC_LINE.test(p));
    const sections = splitSections(pages.join('\n'), faaAcHeadingLevel);
    return sectionChunks(
      {
        sourceId: 'FAA AC 150/5210-20A',
        url: FAA_AC_URL,
        title:
          'FAA AC 150/5210-20A Ground Vehicle Operations to include Taxiing or Towing an Aircraft on Airports',
        jurisdiction: 'US',
        date: '2015-09-01',
        collection: 'procedure',
        licence: 'Public domain (US Government work, FAA Advisory Circular)',
      },
      sections,
      { source: 'FAA AC 150/5210-20A', docPrefix: 'faa-ac-5210-20a', maxChunks: 200 },
    );
  },
};

export const cap642Step: SourceStep = {
  id: 'caa-cap642',
  collection: 'procedure',
  licence: '© UK Civil Aviation Authority; quoted with attribution (CAP 642 Airside Safety Management)',
  async run() {
    const path = await download(CAP642_URL, 'caa-cap642.pdf', { minBytes: 10_000 });
    const raw = await pdfPages(path);
    const { titles, chapters } = cap642Headings(raw);
    const firstBody = raw.findIndex((p, i) => i > 1 && !isCapTocPage(p));
    let text = stripRepeatedLines(raw.slice(Math.max(2, firstBody))).join('\n');
    // Join "Chapter 2" + its title line into one level-1 heading.
    text = text.replace(/^(Chapter \d+|Appendix \w+)\n(.+)$/gm, (all, a: string, b: string) =>
      chapters.get(a) === b.trim() ? `${a}: ${b.trim()}` : all,
    );
    const sections: Section[] = splitSections(text, (line) =>
      /^(Chapter \d+|Appendix \w+): /.test(line) ? 1 : titles.has(line) ? 2 : 0,
    );
    return sectionChunks(
      {
        sourceId: 'UK CAA CAP 642',
        url: CAP642_URL,
        title: 'UK CAA CAP 642 Airside Safety Management',
        jurisdiction: 'UK',
        date: '2018-11',
        collection: 'procedure',
        licence: '© UK Civil Aviation Authority; quoted with attribution (CAP 642 Airside Safety Management)',
        meta: { attribution: 'Source: UK Civil Aviation Authority, CAP 642 Airside Safety Management.' },
      },
      sections,
      { source: 'UK CAA CAP 642 Airside Safety Management', docPrefix: 'caa-cap642', maxChunks: 250 },
    );
  },
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
          body = stripRepeatedLines(await pdfPages(pdfPath), { minShare: 0.5, drop: AIRBUS_DROP }).join('\n');
        } else body = htmlToText(html, 'body');
        if (body.length < 1500) continue;
        if (/copyright/i.test(body.slice(0, 400))) continue; // third-party copyright indicated: skip
        const sections = splitSections(body, airbusHeadingLevel, (l) => l.replace(/\.$/, ''));
        out.push(
          ...sectionChunks(
            {
              sourceId: `Airbus Safety First: ${title}`.slice(0, 120),
              url,
              title: `Airbus Safety First — ${title}`,
              collection: 'procedure',
              licence: airbusStep.licence,
              meta: { attribution: AIRBUS_ACK },
            },
            sections,
            { source: `Airbus Safety First — ${title}`, docPrefix: `airbus-${name}`, maxChunks: 20 },
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
    const path = await download(url, 'fsf-ramp-template.pdf', { minBytes: 10_000 });
    const text = stripRepeatedLines(await pdfPages(path)).join('\n');
    return sectionChunks(
      {
        sourceId: 'FSF ramp procedures template',
        url,
        title: 'Flight Safety Foundation ground accident prevention — ramp operational procedures template',
        collection: 'procedure',
        licence: fsfStep.licence,
      },
      splitSections(text, airbusHeadingLevel),
      { source: 'Flight Safety Foundation ramp procedures template', docPrefix: 'fsf-ramp', maxChunks: 200 },
    );
  },
};
