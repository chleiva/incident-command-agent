/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  Bm25Scorer,
  bestQuote,
  buildBm25,
  chunkText,
  cosineQuantised,
  distanceKm,
  getStation,
  isEuStation,
  l2normalise,
  localHhMm,
  parseChunks,
  quantise,
  stations,
  tokenize,
  utcOffsetMinutes,
} from './index';

describe('text', () => {
  it('tokenizes with stopwords, light stemming and whole MEL item numbers', () => {
    expect(tokenize('The APU is inoperative per MEL 49-10-01')).toEqual([
      '49-10-01',
      'apu',
      'inoperative',
      'mel',
      '49',
      '10',
      '01',
    ]);
    expect(tokenize('Deferred defects, deferrals')).toEqual(['deferr', 'defect', 'deferral']);
  });

  it('chunks to about the target size on paragraph/sentence boundaries', () => {
    const para = 'Word '.repeat(200).trim() + '.';
    const chunks = chunkText([para, para, para].join('\n\n'), 500);
    expect(chunks.length).toBe(3);
    for (const c of chunks) expect(c.split(/\s+/).length).toBeLessThanOrEqual(375);
    expect(chunkText('')).toEqual([]);
  });

  it('bestQuote returns a verbatim substring ≤ max length covering the query', () => {
    const text =
      'Intro sentence about nothing. The APU may be inoperative provided repairs are made within 4 flights. Unrelated closing words here.'.repeat(
        4,
      );
    const q = bestQuote(text, 'APU inoperative repairs', 120);
    expect(q.length).toBeLessThanOrEqual(120);
    expect(text).toContain(q);
    expect(q).toMatch(/APU may be inoperative/);
  });
});

describe('bm25 and embeddings', () => {
  it('ranks the matching document first', () => {
    const p = buildBm25([
      'tug struck the nose gear during pushback',
      'passenger care vouchers',
      'hydraulic leak on stand',
    ]);
    const s = new Bm25Scorer(p).score('pushback tug');
    expect([...s.entries()].sort((a, b) => b[1] - a[1])[0][0]).toBe(0);
    expect(new Bm25Scorer(p).score('pushback', (d) => d !== 0).size).toBe(0);
  });

  it('int8 quantisation keeps cosine similarity', () => {
    const a = l2normalise(Float32Array.from([0.1, 0.9, -0.3, 0.2]));
    const b = l2normalise(Float32Array.from([0.12, 0.85, -0.25, 0.1]));
    const { data, scales } = quantise([b], 4);
    const exact = a.reduce((s, x, i) => s + x * b[i], 0);
    expect(cosineQuantised(a, data, scales, 0, 4)).toBeCloseTo(exact, 2);
  });
});

describe('stations', () => {
  it('has the scenario stations with coordinates; haversine distances', () => {
    for (const s of ['MAN', 'PMI', 'EDI', 'FAO', 'AGP', 'DUB', 'ALC', 'TFS'])
      expect(getStation(s), s).toBeDefined();
    expect(distanceKm('MAN', 'DUB')).toBeGreaterThan(250);
    expect(distanceKm('MAN', 'DUB')).toBeLessThan(290);
    expect(distanceKm('MAN', 'TFS')).toBeGreaterThan(2900);
    expect(distanceKm('MAN', 'MAN')).toBe(0);
    expect(() => distanceKm('MAN', 'ZZZ')).toThrow();
    expect(stations.length).toBeGreaterThan(300);
  });

  it('EU membership and local time with EU summer time', () => {
    expect(isEuStation('DUB')).toBe(true);
    expect(isEuStation('MAN')).toBe(false);
    expect(utcOffsetMinutes('MAN', new Date('2026-06-12T12:00:00Z'))).toBe(60);
    expect(utcOffsetMinutes('MAN', new Date('2026-01-12T12:00:00Z'))).toBe(0);
    expect(utcOffsetMinutes('AGP', new Date('2026-06-12T12:00:00Z'))).toBe(120);
    expect(utcOffsetMinutes('TFS', new Date('2026-06-12T12:00:00Z'))).toBe(60);
    expect(localHhMm('MAN', new Date('2026-06-12T22:30:00Z'))).toBe('23:30');
  });
});

describe('fixture mini-corpus', () => {
  it('covers every collection, with licences and no AAIB text', () => {
    const chunks = parseChunks(readFileSync(new URL('../fixtures/corpus.jsonl', import.meta.url), 'utf8'));
    expect(chunks.length).toBeGreaterThanOrEqual(30);
    expect(new Set(chunks.map((c) => c.collection))).toEqual(
      new Set(['mel', 'rules', 'passenger_rights', 'procedure', 'precedent']),
    );
    for (const c of chunks) {
      expect(c.licence.length).toBeGreaterThan(5);
      expect(c.sourceId.startsWith('AAIB')).toBe(false);
    }
    for (const c of chunks.filter((x) => x.sourceId.startsWith('ASRS')))
      expect(c.meta?.disclaimer).toMatch(/not verified by NASA/);
    // Structural chunk format (v2): every chunk has a docId and a context header kept apart from the verbatim text.
    for (const c of chunks) {
      expect(c.docId && c.chunkId.startsWith(`${c.docId}#`)).toBe(true);
      expect(c.header).toMatch(/ › /);
      expect(c.text.startsWith(c.header!)).toBe(false);
    }
  });
});
