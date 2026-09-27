/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Text utilities shared by the kb:build pipeline and the runtime retriever. The tokenizer MUST be identical at build
 * and query time (BM25 statistics depend on it), which is why it lives here and nowhere else.
 */

const STOPWORDS = new Set(
  (
    'a an and are as at be been being but by can could did do does for from had has have he her his i if in into is ' +
    'it its me my no nor not of on or our she so than that the their them then there these they this those to too ' +
    'up us was we were what when where which while who will with would you your shall may must should all any each ' +
    'other such only own same very s t just about above after again against below between both during further here ' +
    'how more most off once out over some under until why also per via'
  ).split(' '),
);

/** Very light, deterministic suffix stemmer (Porter-lite). */
export function stem(word: string): string {
  if (word.length <= 3 || /\d/.test(word)) return word;
  let w = word;
  if (w.endsWith('ies') && w.length > 4) w = w.slice(0, -3) + 'y';
  else if (w.endsWith('sses')) w = w.slice(0, -2);
  else if (w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is')) w = w.slice(0, -1);
  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  else if (w.length > 5 && w.endsWith('ly')) w = w.slice(0, -2);
  return w;
}

/**
 * Tokenize for BM25: lower-case, split on non-alphanumerics, drop stopwords, stem. Hyphenated item numbers such as
 * MEL `21-31-01` are kept whole as well as split, so an exact item number query ranks its chunk first.
 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  const lower = text.toLowerCase();
  for (const m of lower.matchAll(/\b\d{2}-\d{2}(?:-\d{2})?\b/g)) out.push(m[0]);
  for (const raw of lower.split(/[^a-z0-9]+/)) {
    if (!raw || raw.length > 40) continue;
    if (STOPWORDS.has(raw)) continue;
    if (raw.length === 1 && !/\d/.test(raw)) continue;
    out.push(stem(raw));
  }
  return out;
}

const SOFT_HYPHEN = new RegExp(String.fromCharCode(0xad), 'g');
const CONTROL_CHARS = new RegExp(
  `[${[
    [0, 8],
    [11, 12],
    [14, 31],
  ]
    .map(([a, b]) => `${String.fromCharCode(a)}-${String.fromCharCode(b)}`)
    .join('')}]`,
  'g',
);
const HORIZONTAL_SPACE = new RegExp(`[ \\t${String.fromCharCode(0xa0)}]+`, 'g');

/** Collapse whitespace and strip control characters. */
export function cleanText(text: string): string {
  return text
    .replace(SOFT_HYPHEN, '')
    .replace(CONTROL_CHARS, ' ')
    .replace(HORIZONTAL_SPACE, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Rough token estimate (≈ 0.75 words per token for English prose). */
export function estimateTokens(text: string): number {
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.ceil(words / 0.75);
}

/** Abbreviations that end with a period but do not end a sentence (lower-cased, without the period). */
const ABBREVIATIONS = new Set(
  (
    'no nos fig figs e.g i.e etc vs approx ref refs art arts para paras reg regs sect para mr mrs ms dr st ' +
    'u.s u.k inc ltd co corp dept min max nr op cf al'
  ).split(' '),
);

/**
 * Sentence-safe split: breaks after `.`, `!`, `?` followed by whitespace and an upper-case letter, digit, quote or
 * bracket, but never after a known abbreviation ("No.", "e.g."), a single capital initial ("J."), or inside a decimal
 * ("3.5"). Line breaks are kept inside sentences. The concatenation of the pieces (joined by one space) reproduces the
 * input modulo whitespace.
 */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  const re = /[.!?]["')\]]?\s+(?=["'([]?[A-Z0-9•●])/g;
  for (const m of text.matchAll(re)) {
    const end = (m.index ?? 0) + m[0].trimEnd().length;
    const before = text.slice(start, end);
    const lastWord = (before.match(/(\S+)[.!?]["')\]]?$/)?.[1] ?? '').toLowerCase().replace(/^\(/, '');
    if (m[0][0] === '.' && (ABBREVIATIONS.has(lastWord) || /^[a-z]$/i.test(lastWord))) continue;
    const s = before.trim();
    if (s) out.push(s);
    start = (m.index ?? 0) + m[0].length;
  }
  const tail = text.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

/** Normalise a line for repeated-line detection: digits collapse to `#`, whitespace to one space. */
function lineKey(line: string): string {
  return line.trim().replace(/\d+/g, '#').replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Pre-clean paged text: drop running page headers/footers and repeated disclaimers, i.e. short lines (≤ `maxLen`
 * chars) that recur — digits ignored — on at least `minShare` of the pages (and on ≥ 3 pages), plus any line matching
 * `drop`. Returns the pages with those lines removed and whitespace normalised.
 */
export function stripRepeatedLines(
  pages: string[],
  opts: { minShare?: number; maxLen?: number; drop?: RegExp[] } = {},
): string[] {
  const minShare = opts.minShare ?? 0.3;
  const maxLen = opts.maxLen ?? 140;
  const counts = new Map<string, number>();
  for (const p of pages) {
    const seen = new Set<string>();
    for (const l of p.split('\n')) {
      if (!l.trim() || l.trim().length > maxLen) continue;
      const k = lineKey(l);
      if (!seen.has(k)) {
        seen.add(k);
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
    }
  }
  const threshold = Math.max(3, Math.ceil(pages.length * minShare));
  const repeated = new Set([...counts].filter(([, n]) => n >= threshold).map(([k]) => k));
  return pages.map((p) =>
    cleanText(
      p
        .split('\n')
        .filter((l) => {
          const t = l.trim();
          if (!t) return true;
          if (t.length <= maxLen && repeated.has(lineKey(t))) return false;
          return !(opts.drop ?? []).some((re) => re.test(t));
        })
        .join('\n'),
    ),
  );
}

/**
 * Split text into chunks of about `targetTokens` tokens on paragraph, then sentence, boundaries. Never returns an
 * empty chunk. Deterministic.
 */
export function chunkText(text: string, targetTokens = 500): string[] {
  const clean = cleanText(text);
  if (!clean) return [];
  const maxWords = Math.floor(targetTokens * 0.75);
  const pieces: string[] = [];
  for (const para of clean.split(/\n\n+/)) {
    const words = para.split(/\s+/).filter(Boolean);
    if (words.length <= maxWords) {
      pieces.push(para);
      continue;
    }
    // Long paragraph: split on sentence ends, then hard-wrap if a sentence is itself too long.
    const sentences = para.split(/(?<=[.!?;])\s+/);
    for (const s of sentences) {
      const sw = s.split(/\s+/).filter(Boolean);
      if (sw.length <= maxWords) pieces.push(s);
      else for (let i = 0; i < sw.length; i += maxWords) pieces.push(sw.slice(i, i + maxWords).join(' '));
    }
  }
  const chunks: string[] = [];
  let cur: string[] = [];
  let curWords = 0;
  for (const p of pieces) {
    const n = p.split(/\s+/).filter(Boolean).length;
    if (curWords > 0 && curWords + n > maxWords) {
      chunks.push(cur.join('\n\n'));
      cur = [];
      curWords = 0;
    }
    cur.push(p);
    curWords += n;
  }
  if (cur.length) chunks.push(cur.join('\n\n'));
  return chunks.filter((c) => c.trim().length > 0);
}

/**
 * Pick a verbatim quote (≤ maxLen chars) from `text` that best covers the query terms: a sliding window over
 * sentences. The result is always an exact substring of `text`.
 */
export function bestQuote(text: string, query: string, maxLen = 300): string {
  if (text.length <= maxLen) return text;
  const q = new Set(tokenize(query));
  const sentences: { start: number; end: number }[] = [];
  const re = /[^.!?\n]+[.!?]?/g;
  for (const m of text.matchAll(re)) {
    const start = m.index ?? 0;
    sentences.push({ start, end: start + m[0].length });
  }
  let best = { score: -1, start: 0, end: Math.min(maxLen, text.length) };
  for (let i = 0; i < sentences.length; i++) {
    let start = sentences[i].start;
    while (start < text.length && /\s/.test(text[start])) start++;
    let end = sentences[i].end;
    for (let j = i + 1; j < sentences.length && sentences[j].end - start <= maxLen; j++)
      end = sentences[j].end;
    if (end - start > maxLen) end = start + maxLen;
    const window = text.slice(start, end);
    const toks = tokenize(window);
    let score = 0;
    const seen = new Set<string>();
    for (const t of toks) {
      if (q.has(t) && !seen.has(t)) {
        seen.add(t);
        score += 1;
      }
    }
    if (score > best.score) best = { score, start, end };
  }
  return text.slice(best.start, best.end).trimEnd();
}
