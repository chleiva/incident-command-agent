/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** Per-collection chunking strategies on fixture snippets (public-domain / reuse-permitted text shapes). */
import { describe, expect, it } from 'vitest';
import {
  articleChunks,
  chunkingReport,
  contextHeader,
  melItemChunks,
  packUnits,
  reportChunks,
  ruleChunks,
  sectionChunks,
  splitSections,
  topLevelParagraphs,
  type ChunkBase,
} from './chunking';
import {
  Bm25Scorer,
  bm25FromFiles,
  buildBm25,
  compactChunks,
  decodePostings,
  encodePostings,
  indexText,
  parseChunks,
  sourceFamily,
  vectorFilter,
  vectorMetadata,
  type ChunkRecord,
} from './format';
import { estimateTokens, splitSentences, stripRepeatedLines } from './text';

const base = (over: Partial<ChunkBase> = {}): ChunkBase => ({
  sourceId: 'SRC',
  url: 'https://example.invalid/doc',
  title: 'Doc',
  collection: 'procedure',
  licence: 'test licence',
  ...over,
});
const sentence = (i: number) => `Sentence number ${i} describes the towing procedure in some detail.`;
const prose = (n: number, from = 0) => Array.from({ length: n }, (_, i) => sentence(i + from)).join(' ');

describe('text pre-clean', () => {
  it('splits sentences safely (abbreviations, initials, decimals)', () => {
    const s = splitSentences(
      'See Fig. 3 and No. 5 for details. The tug weighs 3.5 tonnes. J. Smith agreed. Then (a) applies.',
    );
    expect(s).toEqual([
      'See Fig. 3 and No. 5 for details.',
      'The tug weighs 3.5 tonnes.',
      'J. Smith agreed.',
      'Then (a) applies.',
    ]);
  });

  it('strips running headers/footers and repeated disclaimers, keeping body lines', () => {
    const pages = [1, 2, 3, 4].map(
      (n) =>
        `CAP 642 Chapter 2\nNovember 2018 Page ${n}\nBody line ${'x'.repeat(n)} unique text\nCheck the latest version`,
    );
    const out = stripRepeatedLines(pages, { drop: [/^Check the latest/] });
    for (const [i, p] of out.entries()) {
      expect(p).not.toMatch(/CAP 642|November 2018|Check the latest/);
      expect(p).toContain(`Body line ${'x'.repeat(i + 1)}`);
    }
  });
});

describe('context headers', () => {
  it('builds source › section path › jurisdiction › date (+ extra lines), deterministic', () => {
    const h = contextHeader({
      source: 'EASA Easy Access Rules',
      path: ['ORO.FTL.205 Flight duty period (FDP)', undefined, '(d) Extensions'],
      jurisdiction: 'EU',
      date: '2026-03',
      extra: ['Synopsis: something   happened', undefined],
    });
    expect(h).toBe(
      'EASA Easy Access Rules › ORO.FTL.205 Flight duty period (FDP) › (d) Extensions › EU › 2026-03\nSynopsis: something happened',
    );
  });

  it('is embedded and indexed with the text, but the text stays verbatim', () => {
    const [c] = reportChunks(base({ collection: 'precedent' }), {
      docId: 'asrs-1',
      reportId: 'ASRS ACN 1',
      synopsis: 'Tug struck the nose gear.',
      text: 'Narrative: the tug hit us.',
    });
    expect(c.text).toBe('Narrative: the tug hit us.');
    expect(indexText(c)).toBe(`${c.header}\n\nNarrative: the tug hit us.`);
    expect(c.header).toContain('Synopsis: Tug struck the nose gear.');
  });
});

describe('packUnits', () => {
  it('keeps units whole, overlaps ~15% only when a section yields several chunks, keeps tables whole', () => {
    const paras = Array.from({ length: 6 }, (_, i) => prose(8, i * 8));
    const parts = packUnits(paras, { maxTokens: 300, overlap: 0.15 });
    expect(parts.length).toBeGreaterThan(1);
    for (let i = 1; i < parts.length; i++) {
      const prevLast = splitSentences(parts[i - 1]).at(-1)!;
      expect(parts[i].startsWith(prevLast) || parts[i].includes(prevLast)).toBe(true);
    }
    expect(packUnits([prose(3)], { maxTokens: 300, overlap: 0.15 })).toEqual([prose(3)]);
    const table = `Table 2\n${'13:00 12:30 12:00 '.repeat(200)}`;
    expect(packUnits([table], { maxTokens: 100, keepWhole: (u) => u.startsWith('Table') })).toEqual([
      table.trim(),
    ]);
  });
});

describe('mel strategy', () => {
  const item = {
    itemNumber: '49-10-01',
    title: 'APU System',
    chapter: '49. Airborne Auxiliary Power',
    body: '1) A320 without Mod. 163213\nC 1 0 (O) Except for ETOPS, may be inoperative.\nA 1 0 (O) (M) May be inoperative provided repairs are made within 4 flights.',
  };

  it('one chunk per item with item header, category + repair interval, (M)/(O) and metadata', () => {
    const chunks = melItemChunks(
      base({ sourceId: 'FAA MMEL A-320 49-10-01', collection: 'mel', jurisdiction: 'US' }),
      item,
    );
    expect(chunks).toHaveLength(1);
    const [c] = chunks;
    expect(c.chunkId).toBe('mmel-49-10-01#1');
    expect(c.docId).toBe('mmel-49-10-01');
    expect(c.text).toBe(item.body);
    expect(c.header).toContain('FAA MMEL A-320 › 49. Airborne Auxiliary Power › 49-10-01 APU System › US');
    expect(c.header).toContain('A: interval as specified in the remarks; C: 10 consecutive calendar days');
    expect(c.header).toMatch(/\(M\) maintenance procedure required; \(O\) operations procedure required/);
    expect(c.meta).toMatchObject({ itemNumber: '49-10-01', ataChapter: '49', category: 'A,C' });
  });

  it('splits an oversized item between sub-items and repeats the item header in every part', () => {
    const subs = Array.from({ length: 12 }, (_, i) => `${i + 1}) Variant ${i}\nC 1 0 (O) ${prose(12)}`);
    const chunks = melItemChunks(base({ sourceId: 'FAA MMEL A-320 21-00-01', collection: 'mel' }), {
      ...item,
      itemNumber: '21-00-01',
      body: subs.join('\n'),
    });
    expect(chunks.length).toBeGreaterThan(1);
    expect(new Set(chunks.map((c) => c.header)).size).toBe(1);
    expect(new Set(chunks.map((c) => c.docId))).toEqual(new Set(['mmel-21-00-01']));
    for (const c of chunks) {
      expect(c.text).toMatch(/^\d{1,2}\) Variant/); // parts start at a sub-item boundary
      expect(estimateTokens(indexText(c))).toBeLessThanOrEqual(900);
    }
  });
});

describe('rules strategy', () => {
  const ir = {
    kind: 'IR' as const,
    ref: 'ORO.FTL.205',
    rule: 'ORO.FTL.205',
    title: 'Flight duty period (FDP)',
    body: [
      '(a) The operator shall:',
      '(1) define reporting times;',
      '(b) Basic maximum daily FDP.',
      '(1) The maximum daily FDP shall be in accordance with the following table:',
      'Table 2',
      '0600–1329 13:00 12:30 12:00',
      '(c) FDP with different reporting time for flight crew and cabin crew.',
      '(d) Maximum daily FDP with the use of extensions.',
      '(i) the minimum rest shall be increased;',
    ].join('\n'),
  };

  it('one chunk per top-level sub-paragraph with a hierarchical path; tables stay in their sub-paragraph', () => {
    const chunks = ruleChunks(
      base({ sourceId: 'EASA ORO.FTL.205', collection: 'rules', jurisdiction: 'EU' }),
      ir,
    );
    expect(chunks.map((c) => c.chunkId)).toEqual([
      'easa-ORO.FTL.205-a#1',
      'easa-ORO.FTL.205-b#1',
      'easa-ORO.FTL.205-c#1',
      'easa-ORO.FTL.205-d#1',
    ]);
    const b = chunks[1];
    expect(b.header).toContain('ORO.FTL.205 Flight duty period (FDP) › (b) Basic maximum daily FDP. › EU');
    expect(b.text).toContain('Table 2\n0600–1329 13:00 12:30 12:00');
    expect(b.section).toBe('ORO.FTL.205(b)');
    expect(chunks[3].text).toContain('(i) the minimum rest'); // roman items are not top-level
  });

  it('parses sub-paragraphs in sequence only', () => {
    expect(topLevelParagraphs('intro\n(a) one\n(c) not next\n(b) two').map((p) => p.label)).toEqual([
      undefined,
      '(a)',
      '(b)',
    ]);
  });

  it('an AMC/GM element is one chunk under its rule', () => {
    const [c, ...rest] = ruleChunks(base({ collection: 'rules' }), {
      kind: 'AMC',
      ref: 'AMC1 ORO.FTL.205(f)',
      rule: 'ORO.FTL.205',
      title: 'Flight Duty Period (FDP)',
      body: "UNFORESEEN CIRCUMSTANCES — COMMANDER'S DISCRETION\n(a) As general guidance…\n(b) The policy…",
    });
    expect(rest).toHaveLength(0);
    expect(c.chunkId).toBe('easa-AMC1-ORO.FTL.205-f#1');
    expect(c.header).toContain('ORO.FTL.205 › AMC1 ORO.FTL.205(f) Flight Duty Period (FDP)');
  });
});

describe('passenger-rights strategy', () => {
  it('one chunk per article with its title', () => {
    const [c] = articleChunks(
      base({
        sourceId: 'EU Reg 261/2004 Art 14',
        collection: 'passenger_rights',
        jurisdiction: 'EU',
        date: '2004-02-11',
      }),
      {
        number: '14',
        title: 'Obligation to inform passengers of their rights',
        text: 'Article 14\nObligation to inform passengers of their rights\n1. The operating air carrier shall ensure…',
      },
      { source: 'Regulation (EC) No 261/2004', docPrefix: 'eu261' },
    );
    expect(c.chunkId).toBe('eu261-art14#1');
    expect(c.header).toBe(
      'Regulation (EC) No 261/2004 › Article 14 — Obligation to inform passengers of their rights › EU › 2004-02-11',
    );
  });
});

describe('procedure strategy', () => {
  it('splits at headings, merges small siblings, packs long sections 300–600 tokens with overlap', () => {
    const text = [
      'CHAPTER 3. VEHICLES',
      '3.1 Vehicles on Airports.',
      prose(4),
      '3.2 Vehicular Access Control.',
      prose(4, 10),
      '3.3 Vehicle Requirements.',
      ...Array.from({ length: 10 }, (_, i) => prose(8, 100 + i * 8)),
    ].join('\n\n');
    const level = (l: string) => (/^CHAPTER/.test(l) ? 1 : /^\d+\.\d+ [A-Z].*\.$/.test(l) ? 2 : 0);
    const sections = splitSections(text, level);
    expect(sections.map((s) => s.path.join(' / '))).toEqual([
      'CHAPTER 3. VEHICLES / 3.1 Vehicles on Airports',
      'CHAPTER 3. VEHICLES / 3.2 Vehicular Access Control',
      'CHAPTER 3. VEHICLES / 3.3 Vehicle Requirements',
    ]);
    const chunks = sectionChunks(base({ jurisdiction: 'US' }), sections, {
      source: 'FAA AC',
      docPrefix: 'faa',
    });
    // 3.1 and 3.2 are small siblings: merged into one chunk, both headings in the breadcrumb.
    expect(chunks[0].header).toBe(
      'FAA AC › CHAPTER 3. VEHICLES › 3.1 Vehicles on Airports; 3.2 Vehicular Access Control › US',
    );
    const long = chunks.filter((c) => c.docId === 'faa-s002');
    expect(long.length).toBeGreaterThan(1);
    for (const c of long) {
      expect(estimateTokens(c.text)).toBeLessThanOrEqual(600);
      expect(c.header).toContain('3.3 Vehicle Requirements');
    }
    // ~15% overlap: part 2 starts with the tail of part 1.
    const tail = splitSentences(long[0].text).at(-1)!;
    const head = long[1].text.split('\n\n')[0];
    expect(head.endsWith(tail)).toBe(true);
    expect(estimateTokens(head)).toBeLessThanOrEqual(90); // ≈ 15% of 600
  });
});

describe('precedent strategy', () => {
  it('one report = one chunk up to ~1,000 tokens', () => {
    const chunks = reportChunks(base({ collection: 'precedent', jurisdiction: 'US', date: '2018-09' }), {
      docId: 'asrs-1577181',
      reportId: 'ASRS ACN 1577181',
      synopsis: 'Tow bar pin sheared during pushback.',
      aircraftType: 'A320',
      phase: 'Taxi',
      eventType: 'Ground Event / Encounter Other',
      text: `Narrative: ${prose(40)}`,
    });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].chunkId).toBe('asrs-1577181#1');
    expect(chunks[0].header).toBe(
      'ASRS ACN 1577181 › US › 2018-09\nSynopsis: Tow bar pin sheared during pushback.\nAircraft: A320; Phase: Taxi; Event: Ground Event / Encounter Other',
    );
    expect(chunks[0].meta).toMatchObject({ phase: 'Taxi', aircraftType: 'A320' });
  });

  it('longer reports are split, the header repeated on every part; parts are capped', () => {
    const r = {
      docId: 'aaib-x',
      reportId: 'AAIB report: X',
      synopsis: 'Nose gear collapsed during pushback.',
      text: Array.from({ length: 12 }, (_, i) => prose(20, i * 20)).join('\n\n'),
    };
    const all = reportChunks(base({ collection: 'precedent' }), r);
    expect(all.length).toBeGreaterThan(2);
    expect(new Set(all.map((c) => c.header)).size).toBe(1);
    expect(new Set(all.map((c) => c.docId))).toEqual(new Set(['aaib-x']));
    expect(reportChunks(base({ collection: 'precedent' }), r, { maxParts: 2 })).toHaveLength(2);
  });
});

describe('chunking report and index compaction', () => {
  const chunks: ChunkRecord[] = [
    ...reportChunks(
      base({ collection: 'precedent', sourceId: 'ASRS ACN 1', meta: { disclaimer: 'NASA disclaimer' } }),
      {
        docId: 'asrs-1',
        reportId: 'ASRS ACN 1',
        text: Array.from({ length: 8 }, (_, i) => prose(20, i * 20)).join('\n\n'),
      },
    ),
    ...reportChunks(
      base({ collection: 'precedent', sourceId: 'ASRS ACN 2', meta: { disclaimer: 'NASA disclaimer' } }),
      {
        docId: 'asrs-2',
        reportId: 'ASRS ACN 2',
        text: 'Narrative: short.',
      },
    ),
  ];

  it('reports counts, docs, split docs and the token distribution per collection', () => {
    const r = chunkingReport(chunks);
    expect(r.precedent.chunks).toBe(chunks.length);
    expect(r.precedent.docs).toBe(2);
    expect(r.precedent.splitDocs).toBe(1);
    expect(r.precedent.tokens.max).toBeGreaterThanOrEqual(r.precedent.tokens.p50);
  });

  it('stores shared fields once per group and restores them on parse', () => {
    const { lines, defaults } = compactChunks(chunks);
    expect(defaults.asrs).toMatchObject({ licence: 'test licence', meta: { disclaimer: 'NASA disclaimer' } });
    expect(lines[0]).not.toContain('NASA disclaimer');
    const back = parseChunks(lines.join('\n'), defaults);
    expect(back.map((c) => ({ ...c, meta: { disclaimer: c.meta?.disclaimer } }))).toEqual(
      chunks.map((c) => ({ ...c, meta: { disclaimer: c.meta?.disclaimer } })),
    );
  });

  it('varint postings round-trip (docs + tf) and score like the raw postings', () => {
    const texts = [
      'tug tug pushback',
      'pushback towbar',
      'catering truck door',
      'tug'.repeat(1) + ' shear pin',
    ];
    const bm = buildBm25(texts);
    const enc = encodePostings(bm.docs, bm.tf, bm.stats.offsets);
    const dec = decodePostings(enc, bm.stats.offsets);
    expect([...dec.docs]).toEqual([...bm.docs]);
    expect([...dec.tf]).toEqual([...bm.tf]);
    const s1 = new Bm25Scorer(bm).score('tug pushback');
    const s2 = new Bm25Scorer(
      bm25FromFiles(bm.stats, { k1: 1.2, b: 0.75, encoding: 'varint-delta-tf' }, enc, undefined),
    ).score('tug pushback');
    expect([...s2]).toEqual([...s1]);
  });

  it('builds filterable vector metadata (no text) and S3 Vectors filters', () => {
    const [c] = melItemChunks(
      base({ sourceId: 'FAA MMEL A-320 49-10-01', collection: 'mel', jurisdiction: 'US' }),
      {
        itemNumber: '49-10-01',
        title: 'APU',
        body: 'C 1 0 (O) May be inoperative.',
      },
    );
    const m = vectorMetadata(c);
    expect(m).toEqual({
      collection: 'mel',
      jurisdiction: 'US',
      sourceId: 'FAA MMEL A-320 49-10-01',
      docId: 'mmel-49-10-01',
      itemNumber: '49-10-01',
      ataChapter: '49',
    });
    expect(JSON.stringify(m).length).toBeLessThan(2048);
    expect(vectorMetadata({ ...c, jurisdiction: undefined }).jurisdiction).toBe('ANY');
    expect(vectorFilter({ collections: ['mel'] })).toEqual({ collection: { $eq: 'mel' } });
    expect(vectorFilter({ collections: ['mel', 'rules'], jurisdiction: 'EU' })).toEqual({
      $and: [{ collection: { $in: ['mel', 'rules'] } }, { jurisdiction: { $in: ['EU', 'ANY'] } }],
    });
    expect(vectorFilter({})).toBeUndefined();
    expect(sourceFamily('ASRS ACN 1577181')).toBe('ASRS');
    expect(sourceFamily('FAA MMEL A-320 49-10-01')).toBe('FAA MMEL A-320');
  });
});
