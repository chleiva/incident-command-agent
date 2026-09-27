/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * EASA Easy Access Rules for Air Operations: only the implementing-rule text of ORO.MLR.105 (MEL), ORO.FTL.100–250
 * (flight time limitations, incl. ORO.FTL.205 FDP) and CAT.GEN.MPA.105 (commander's responsibilities).
 * Re-use: "© European Union, 1998-2026" (EUR-Lex legal notice), acknowledged in SOURCES.md.
 */
import type { ChunkRecord } from '../../src/format';
import { cleanText } from '../../src/text';
import { download } from '../lib';
import { makeChunks, pdfPages, type SourceStep } from './types';

export const EASA_PAGE =
  'https://www.easa.europa.eu/en/document-library/easy-access-rules/easy-access-rules-air-operations';
const PDF_URL = 'https://www.easa.europa.eu/en/downloads/20342/en';
const LICENCE =
  '© European Union, 1998-2026 (EASA Easy Access Rules; re-use with attribution per EUR-Lex notice)';

const WANTED =
  /^(ORO\.MLR\.105|ORO\.FTL\.(?:1\d\d|2[0-5]\d)|CAT\.GEN\.MPA\.105)\s+(.+?)\s+Regulation \(E[UC]\)/;
const HEADING =
  /^(?:ORO|CAT|ARO|SPA|NCC|NCO|SPO|IAM|AMC\d*|GM\d*|CS)[ .]\S*.*(?:Regulation \(E[UC]\)|ED Decision)/;

export const easaStep: SourceStep = {
  id: 'easa',
  collection: 'rules',
  licence: LICENCE,
  async run() {
    const path = await download(PDF_URL, 'easa-ear-air-ops.pdf', { minBytes: 1_000_000, timeoutMs: 600_000 });
    const pages = await pdfPages(path);
    const lines: string[] = [];
    for (const p of pages) {
      const ls = p.split('\n');
      const i = ls.findIndex((l) => /Powered by EASA eRules/.test(l));
      lines.push(...(i >= 0 ? ls.slice(i + 1) : ls));
    }
    const rules = new Map<string, { title: string; body: string[] }>();
    let cur: string | undefined;
    for (const line of lines) {
      const t = line.trim();
      const w = t.match(WANTED);
      if (w && !/\.{5,}/.test(t)) {
        cur = w[1];
        if (!rules.has(cur)) rules.set(cur, { title: w[2], body: [] });
        else cur = undefined; // keep the first (IR) occurrence only
        continue;
      }
      if (cur && HEADING.test(t)) cur = undefined;
      if (cur) rules.get(cur)!.body.push(line);
    }
    if (!rules.size) throw new Error('no wanted rules found in the EASA PDF');
    const out: ChunkRecord[] = [];
    for (const [id, r] of rules) {
      out.push(
        ...makeChunks(
          {
            sourceId: `EASA ${id}`,
            url: EASA_PAGE,
            title: `${id} ${r.title}`,
            section: id,
            jurisdiction: 'EU',
            date: '2026-03',
            collection: 'rules',
            licence: LICENCE,
          },
          `${id} ${r.title}\n\n${cleanText(r.body.join('\n'))}`,
          { idPrefix: `easa-${id}`, maxChunks: 12 },
        ),
      );
    }
    return out;
  },
};
