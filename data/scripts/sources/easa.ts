/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * EASA Easy Access Rules for Air Operations: the implementing rules ORO.MLR.105 (MEL), ORO.FTL.100–250 (flight time
 * limitations, incl. ORO.FTL.205 FDP) and CAT.GEN.MPA.105 (commander's responsibilities), with their AMC and GM.
 * One chunk per IR sub-paragraph and per AMC/GM element, hierarchical path header, FDP tables kept whole.
 * Re-use: "© European Union, 1998-2026" (EUR-Lex legal notice), acknowledged in SOURCES.md.
 */
import { ruleChunks, type RuleElement } from '../../src/chunking';
import type { ChunkRecord } from '../../src/format';
import { download } from '../lib';
import { pdfPages, type SourceStep } from './types';

export const EASA_PAGE =
  'https://www.easa.europa.eu/en/document-library/easy-access-rules/easy-access-rules-air-operations';
const PDF_URL = 'https://www.easa.europa.eu/en/downloads/20342/en';
const LICENCE =
  '© European Union, 1998-2026 (EASA Easy Access Rules; re-use with attribution per EUR-Lex notice)';

const WANTED =
  /^(?:(AMC\d+|GM\d+)\s+)?(ORO\.MLR\.105|ORO\.FTL\.(?:1\d\d|2[0-5]\d)|CAT\.GEN\.MPA\.105)(\S*)\s+(.+?)\s+(?:Regulation \(E[UC]\)(?: No)? \d+\/\d+|ED Decision \d+\/\d+\/R)\s*(.*)$/;
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
      // Drop the running page header; pdfPages may have re-flowed the first body line onto its last line.
      const rest =
        i >= 0 ? ls[i].replace(/^.*Powered by EASA eRules Page \d+ of \d+\s*\|?[^|]*?\d{4}\s*/, '') : '';
      const body = i >= 0 ? [...(rest.trim() ? [rest] : []), ...ls.slice(i + 1)] : ls;
      // Re-split sub-paragraph markers that the re-flow glued behind a table row or a number ("09:00 (c) FDP …").
      for (const l of body) lines.push(...l.split(/(?<=[\d.;:])\s+(?=\((?:[a-z]|\d{1,2})\) [A-Z])/));
    }
    const elements = new Map<string, RuleElement & { lines: string[] }>();
    let cur: (RuleElement & { lines: string[] }) | undefined;
    for (const line of lines) {
      const t = line.trim();
      const w = t.match(WANTED);
      if (w && !/\.{5,}/.test(t)) {
        // pdfPages re-flows a wrap before "(": the first body line, e.g. "(a) The operator shall:", can end up on
        // the heading line, after the regulation reference.
        const [, amcGm, rule, suffix, title, rest] = w;
        const ref = `${amcGm ? `${amcGm} ` : ''}${rule}${suffix}`;
        if (elements.has(ref)) {
          cur = undefined; // keep the first occurrence only
          continue;
        }
        cur = {
          kind: amcGm ? (amcGm.startsWith('AMC') ? 'AMC' : 'GM') : 'IR',
          ref,
          rule,
          title: title.trim(),
          body: '',
          lines: rest?.trim() ? [rest.trim()] : [],
        };
        elements.set(ref, cur);
        continue;
      }
      if (cur && HEADING.test(t)) cur = undefined;
      if (cur) cur.lines.push(line);
    }
    if (![...elements.values()].some((e) => e.kind === 'IR'))
      throw new Error('no wanted rules found in the EASA PDF');
    const out: ChunkRecord[] = [];
    for (const el of elements.values()) {
      out.push(
        ...ruleChunks(
          {
            sourceId: `EASA ${el.ref}`,
            url: EASA_PAGE,
            title: `${el.ref} ${el.title}`,
            jurisdiction: 'EU',
            date: '2026-03',
            collection: 'rules',
            licence: LICENCE,
          },
          { ...el, body: el.lines.join('\n') },
        ),
      );
    }
    return out;
  },
};
