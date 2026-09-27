/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * FAA A-320 MMEL (public domain, US Government work) as the MEL stand-in. One chunk per MMEL item (never split
 * unless oversized): item number, title, repair category + interval, dispatch conditions and remarks/(M)(O) quoted
 * verbatim, with a structural header. Plus the definitions/preamble, policy record and acronym pages as sections.
 */
import { melItemChunks, sectionChunks, type Section } from '../../src/chunking';
import type { ChunkRecord } from '../../src/format';
import { cleanText, stripRepeatedLines } from '../../src/text';
import { download } from '../lib';
import { pdfPages, type SourceStep } from './types';

export const MMEL_URL = 'https://www.faa.gov/aircraft/draft_docs/mmel/MMEL_A-320_Rev_32_Draft.pdf';
const LICENCE = 'Public domain (US Government work, FAA MMEL); quoted verbatim';

/** Strip the repeated page header block that ends with the "Sequence No. Item 1 2 3 4 Change / Bar" line. */
function stripHeader(page: string): { chapter?: string; body: string } {
  const lines = page.split('\n');
  const barIdx = lines.findIndex((l, i) => l.trim() === 'Bar' && /Sequence No\./.test(lines[i - 1] ?? ''));
  if (barIdx < 0) return { body: page };
  const chapter = lines.slice(0, barIdx).find((l) => /^\d{2}\. [A-Z]/.test(l.trim()));
  return { chapter: chapter?.trim(), body: lines.slice(barIdx + 1).join('\n') };
}

const ITEM_RE = /^(\d{2}-\d{2}-\d{2}[A-Z]?)\s+(.*)$/;

export const mmelStep: SourceStep = {
  id: 'mmel',
  collection: 'mel',
  licence: LICENCE,
  async run() {
    const path = await download(MMEL_URL, 'mmel-a320.pdf', { minBytes: 100_000 });
    const pages = await pdfPages(path);
    const items = new Map<string, { chapter: string; title: string; lines: string[] }>();
    const preamble: string[] = [];
    let current: string | undefined;
    for (const page of pages) {
      const { chapter, body } = stripHeader(page);
      if (!chapter) {
        if (items.size === 0) preamble.push(page);
        continue;
      }
      for (const raw of body.split('\n')) {
        const line = raw.trim();
        if (!line || line === '(Continued)' || /^\(Cont.d\)$/.test(line)) continue;
        const m = line.match(ITEM_RE);
        if (m) {
          current = m[1];
          const rest = m[2];
          const title = rest.split(/\s+[A-D]\s+(?:\d+|-)\s+(?:\d+|-)\b/)[0].trim();
          const existing = items.get(current);
          if (existing) existing.lines.push(rest.slice(title.length).trim());
          else items.set(current, { chapter, title, lines: [rest.slice(title.length).trim()] });
          continue;
        }
        if (current) items.get(current)!.lines.push(line);
      }
    }
    const out: ChunkRecord[] = [];
    for (const [num, item] of items) {
      // Re-flow the PDF's column wrapping: join lines, then break before sub-items, category rows and notes.
      const body = cleanText(
        item.lines
          .filter(Boolean)
          .join(' ')
          .replace(/\s+/g, ' ')
          .replace(/ (?=\d{1,2}\) )/g, '\n')
          .replace(/ (?=[A-D] (?:\d+|-) (?:\d+|-) )/g, '\n')
          .replace(/ (?=NOTE:)/g, '\n')
          .replace(/ (?=\*{3})/g, '\n'),
      );
      if (!body) continue;
      out.push(
        ...melItemChunks(
          {
            sourceId: `FAA MMEL A-320 ${num}`,
            url: MMEL_URL,
            title: `A320 MMEL ${num} ${item.title}`,
            section: item.chapter,
            jurisdiction: 'US',
            collection: 'mel',
            licence: LICENCE,
          },
          { itemNumber: num, title: item.title, chapter: item.chapter, body },
        ),
      );
    }
    // Preamble: keep the definitions/preamble, the policy application record and the acronyms (grouped by page
    // title); skip the cover, contents, revision log and highlights of change.
    const KEEP = /DEFINITIONS AND PREAMBLE|POLICY APPLICATION RECORD|LIST OF ACRONYMS/;
    const cleaned = stripRepeatedLines(preamble, { minShare: 0.5 });
    const sections: Section[] = [];
    preamble.forEach((raw, i) => {
      const title = raw.match(/^Airbus A320 (.+)$/m)?.[1]?.trim();
      if (!title || !KEEP.test(title)) return;
      const text = cleaned[i]
        .replace(/^.*Airbus A320 .+$/m, '')
        .replace(/^AIRCRAFT:$/m, '')
        .trim();
      const last = sections[sections.length - 1];
      if (last && last.path[0] === title) last.text += `\n\n${text}`;
      else sections.push({ path: [title], text });
    });
    out.push(
      ...sectionChunks(
        {
          sourceId: 'FAA MMEL A-320 preamble',
          url: MMEL_URL,
          title: 'A320 MMEL preamble, definitions and policy record',
          jurisdiction: 'US',
          collection: 'mel',
          licence: LICENCE,
        },
        sections,
        { source: 'FAA MMEL A-320', docPrefix: 'mmel-preamble', maxChunks: 40 },
      ),
    );
    return out;
  },
};
