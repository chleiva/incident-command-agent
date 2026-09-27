/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Structure-aware chunking, one strategy per collection (replaces the generic ~500-token packer):
 *
 *   mel               one chunk per MEL item, never split unless oversized (then per sub-item, header repeated)
 *   rules             one chunk per rule sub-paragraph (IR) or AMC/GM element, hierarchical path, tables kept whole
 *   passenger_rights  one chunk per article (EU 261/2004) or page section (UK CAA)
 *   procedure         heading-aware sections, 300–600 tokens, ~15% overlap only inside long prose, breadcrumb header
 *   precedent         one report = one chunk up to ~1,000 tokens; longer reports split, header repeated on every part
 *
 * Every chunk carries a deterministic structural header (`contextHeader`) that is embedded and BM25-indexed with the
 * text but stored apart from it, so citation quotes stay verbatim. All functions are pure and deterministic.
 */
import type { KnowledgeCollection } from '@ica/schema';
import { indexText, type ChunkRecord, type ChunkStats } from './format';
import { cleanText, estimateTokens, splitSentences } from './text';

export const SEP = ' › ';

export interface HeaderParts {
  /** Source name, e.g. "FAA MMEL A-320", "EASA Air Ops", "ASRS ACN 1234567". */
  source: string;
  /** Section path from the outermost heading inwards. */
  path?: (string | undefined)[];
  jurisdiction?: string;
  date?: string;
  /** Extra lines (report synopsis, MEL item header). */
  extra?: (string | undefined)[];
}

const oneLine = (s: string, max = 400) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};

/** `source › section path › jurisdiction › date` (+ extra lines). Deterministic; no LLM. */
export function contextHeader(p: HeaderParts): string {
  const first = [p.source, ...(p.path ?? []), p.jurisdiction, p.date]
    .filter((x): x is string => !!x && !!x.trim())
    .map((x) => oneLine(x, 160))
    .join(SEP);
  const extra = (p.extra ?? []).filter((x): x is string => !!x && !!x.trim()).map((x) => oneLine(x));
  return [first, ...extra].join('\n');
}

export type ChunkBase = Omit<ChunkRecord, 'chunkId' | 'text' | 'docId' | 'header'>;

/** Hard-wrap a single over-long piece (no sentence boundaries) into pieces of ≤ maxTokens. */
function hardWrap(text: string, maxTokens: number): string[] {
  const maxWords = Math.max(1, Math.floor(maxTokens * 0.75));
  const w = text.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < w.length; i += maxWords) out.push(w.slice(i, i + maxWords).join(' '));
  return out;
}

/** Break a unit that is too long into sentences (then words), each ≤ maxTokens. */
function explode(unit: string, maxTokens: number): string[] {
  if (estimateTokens(unit) <= maxTokens) return [unit];
  const out: string[] = [];
  for (const s of splitSentences(unit)) {
    if (estimateTokens(s) <= maxTokens) out.push(s);
    else out.push(...hardWrap(s, maxTokens));
  }
  return out;
}

export interface PackOptions {
  /** Upper bound per chunk (tokens). */
  maxTokens: number;
  /** Fraction of maxTokens repeated from the end of the previous chunk (only when the input yields > 1 chunk). */
  overlap?: number;
  /** Units that must never be split (e.g. tables); they may exceed maxTokens. */
  keepWhole?: (unit: string) => boolean;
  /** Joiner between units in a chunk. */
  joiner?: string;
}

/**
 * Greedy packer over structural units (paragraphs, sub-items): units are never split unless one alone exceeds
 * `maxTokens` (then at sentence boundaries). With `overlap`, each chunk after the first starts with the trailing
 * sentences of the previous chunk (≈ overlap × maxTokens). Deterministic; never returns empty chunks.
 */
export function packUnits(units: string[], opts: PackOptions): string[] {
  const joiner = opts.joiner ?? '\n\n';
  const pieces: string[] = [];
  for (const u of units.map((x) => x.trim()).filter(Boolean)) {
    if (opts.keepWhole?.(u)) pieces.push(u);
    else pieces.push(...explode(u, opts.maxTokens));
  }
  // Leave room for the overlap so a chunk (overlap + new units) stays within maxTokens.
  const budget = Math.floor(opts.maxTokens * (opts.overlap ?? 0));
  const room = opts.maxTokens - budget;
  const chunks: string[][] = [];
  let cur: string[] = [];
  let curTok = 0;
  for (const p of pieces) {
    const n = estimateTokens(p);
    if (cur.length && curTok + n > room) {
      chunks.push(cur);
      cur = [];
      curTok = 0;
    }
    cur.push(p);
    curTok += n;
  }
  if (cur.length) chunks.push(cur);
  if (!opts.overlap || chunks.length < 2) return chunks.map((c) => c.join(joiner));
  return chunks.map((c, i) => {
    if (i === 0) return c.join(joiner);
    const prevSentences = splitSentences(chunks[i - 1].join(' '));
    const tail: string[] = [];
    let t = 0;
    for (let j = prevSentences.length - 1; j >= 0; j--) {
      const n = estimateTokens(prevSentences[j]);
      if (t + n > budget) break;
      tail.unshift(prevSentences[j]);
      t += n;
    }
    return tail.length ? `${tail.join(' ')}${joiner}${c.join(joiner)}` : c.join(joiner);
  });
}

function records(base: ChunkBase, docId: string, header: string, parts: string[]): ChunkRecord[] {
  return parts
    .filter((t) => t.trim())
    .map((text, i) => ({ ...base, docId, chunkId: `${docId}#${i + 1}`, header, text }));
}

// ------------------------------------------------------------------------------------------------ 1. MEL
/** MMEL repair categories (MMEL definitions): the repair interval each letter stands for. */
export const MEL_REPAIR_INTERVALS: Record<string, string> = {
  A: 'A: interval as specified in the remarks',
  B: 'B: 3 consecutive calendar days',
  C: 'C: 10 consecutive calendar days',
  D: 'D: 120 consecutive calendar days',
};

export interface MelItem {
  itemNumber: string;
  title: string;
  /** e.g. "49. Airborne Auxiliary Power". */
  chapter?: string;
  /** Verbatim item body (sub-items, category rows, remarks/exceptions, (M)/(O) markers). */
  body: string;
}

export const MEL_MAX_TOKENS = 900;

/** Repair categories found in an MMEL item body (`C 1 0 (O) …` rows). */
export function melCategories(body: string): string[] {
  return [
    ...new Set([...body.matchAll(/(?:^|\n|\)\s)([A-D]) (?:\d+|-) (?:\d+|-)\b/g)].map((m) => m[1])),
  ].sort();
}

/**
 * One chunk per MEL item; an oversized item is split between sub-items (`1)`, `2)` …) with the item header repeated
 * in every part. Metadata: itemNumber, ataChapter, category.
 */
export function melItemChunks(base: ChunkBase, item: MelItem, docPrefix = 'mmel'): ChunkRecord[] {
  const cats = melCategories(item.body);
  const procs = [
    /\(M\)/.test(item.body) ? '(M) maintenance procedure required' : '',
    /\(O\)/.test(item.body) ? '(O) operations procedure required' : '',
  ].filter(Boolean);
  const header = contextHeader({
    source: base.sourceId.replace(/\s+\d{2}-\d{2}-\d{2}[A-Z]?$/, ''),
    path: [item.chapter, `${item.itemNumber} ${item.title}`],
    jurisdiction: base.jurisdiction,
    date: base.date,
    extra: [
      `MEL item ${item.itemNumber} ${item.title}. Repair category ${
        cats.length ? cats.map((c) => MEL_REPAIR_INTERVALS[c] ?? c).join('; ') : 'see remarks'
      }.${procs.length ? ` ${procs.join('; ')}.` : ''}`,
    ],
  });
  const body = cleanText(item.body);
  const budget = MEL_MAX_TOKENS - estimateTokens(header);
  const parts =
    estimateTokens(body) <= budget
      ? [body]
      : packUnits(body.split(/\n(?=\d{1,2}\) )/), { maxTokens: budget, joiner: '\n' });
  const b: ChunkBase = {
    ...base,
    meta: {
      ...base.meta,
      itemNumber: item.itemNumber,
      ataChapter: item.itemNumber.slice(0, 2),
      category: cats.join(','),
    },
  };
  return records(b, `${docPrefix}-${item.itemNumber}`, header, parts);
}

// ------------------------------------------------------------------------------------------------ 2. Rules
export interface RuleElement {
  /** `IR` (implementing rule), `AMC` or `GM`. */
  kind: 'IR' | 'AMC' | 'GM';
  /** Full reference as printed, e.g. `ORO.FTL.205` or `AMC1 ORO.FTL.205(f)`. */
  ref: string;
  /** The rule the element belongs to, e.g. `ORO.FTL.205`. */
  rule: string;
  title: string;
  body: string;
}

export const RULE_MAX_TOKENS = 800;
const TABLE_RE = /^Table \d+/m;

/** Split a rule body into its top-level sub-paragraphs `(a)`, `(b)` … (in sequence; anything before `(a)` is intro). */
export function topLevelParagraphs(body: string): { label?: string; text: string }[] {
  const lines = body.split('\n');
  const out: { label?: string; text: string[] }[] = [{ text: [] }];
  let expect = 'a';
  for (const line of lines) {
    const m = line.match(/^\(([a-z])\)\s/);
    if (m && m[1] === expect) {
      out.push({ label: `(${m[1]})`, text: [line] });
      expect = String.fromCharCode(expect.charCodeAt(0) + 1);
      continue;
    }
    out[out.length - 1].text.push(line);
  }
  return out
    .map((p) => ({ label: p.label, text: cleanText(p.text.join('\n')) }))
    .filter((p) => p.text.length > 0);
}

/** Children `(1)`, `(2)` … of a sub-paragraph; a table stays inside the child that introduces it. */
function numberedChildren(text: string): string[] {
  return text.split(/\n(?=\(\d{1,2}\)\s)/);
}

const refSlug = (ref: string) =>
  ref
    .replace(/\s+/g, '-')
    .replace(/[();]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/-$/, '');

/**
 * Implementing rules: one chunk per top-level sub-paragraph with a `rule › (x) title` path; AMC/GM: one chunk per
 * element (split per sub-paragraph only when long). A sub-paragraph longer than RULE_MAX_TOKENS is split between its
 * numbered children; tables are never split.
 */
export function ruleChunks(base: ChunkBase, el: RuleElement, docPrefix = 'easa'): ChunkRecord[] {
  const body = cleanText(el.body);
  const heading = `${el.ref} ${el.title}`;
  const mk = (path: (string | undefined)[]) =>
    contextHeader({
      source: 'EASA Easy Access Rules for Air Operations',
      path,
      jurisdiction: base.jurisdiction,
      date: base.date,
    });
  const out: ChunkRecord[] = [];
  const whole = el.kind !== 'IR' && estimateTokens(body) <= RULE_MAX_TOKENS;
  const paras = whole ? [{ label: undefined, text: body }] : topLevelParagraphs(body);
  if (!paras.length) return out;
  paras.forEach((p, i) => {
    const firstLine = p.text.split('\n')[0];
    const label = p.label ? oneLine(firstLine, 90) : i === 0 ? undefined : `part ${i + 1}`;
    const header = mk([el.kind === 'IR' ? undefined : el.rule, heading, label]);
    const parts =
      estimateTokens(p.text) + estimateTokens(header) <= RULE_MAX_TOKENS
        ? [p.text]
        : packUnits(numberedChildren(p.text), {
            maxTokens: RULE_MAX_TOKENS - estimateTokens(header),
            keepWhole: (u) => TABLE_RE.test(u),
            joiner: '\n',
          });
    const docId = `${docPrefix}-${refSlug(el.ref)}${p.label ? `-${p.label.slice(1, -1)}` : paras.length > 1 ? `-p${i}` : ''}`;
    out.push(
      ...records(
        { ...base, section: p.label ? `${el.ref}${p.label}` : el.ref, meta: { ...base.meta, kind: el.kind } },
        docId,
        header,
        parts,
      ),
    );
  });
  return out;
}

// ------------------------------------------------------------------------------------------------ 3. Articles
export interface Article {
  /** Article number as printed ("14"). */
  number: string;
  title: string;
  /** Verbatim article text (including the "Article N" heading line). */
  text: string;
}

export const ARTICLE_MAX_TOKENS = 900;

/** One chunk per article (split between numbered paragraphs `1.`, `2.` only when longer than ~900 tokens). */
export function articleChunks(
  base: ChunkBase,
  a: Article,
  o: { source: string; docPrefix: string },
): ChunkRecord[] {
  const header = contextHeader({
    source: o.source,
    path: [`Article ${a.number} — ${a.title}`],
    jurisdiction: base.jurisdiction,
    date: base.date,
  });
  const text = cleanText(a.text);
  const budget = ARTICLE_MAX_TOKENS - estimateTokens(header);
  const parts =
    estimateTokens(text) <= budget
      ? [text]
      : packUnits(text.split(/\n(?=\d{1,2}\.\s)/), { maxTokens: budget, joiner: '\n' });
  return records(
    { ...base, section: base.section ?? `Article ${a.number} — ${a.title}` },
    `${o.docPrefix}-art${a.number}`,
    header,
    parts,
  );
}

// ------------------------------------------------------------------------------------------------ 4. Sections
export interface Section {
  /** Heading path, outermost first (e.g. ["Chapter 2", "Aircraft parking safety practices"]). */
  path: string[];
  text: string;
}

export interface SectionChunkOptions {
  source: string;
  docPrefix: string;
  minTokens?: number;
  maxTokens?: number;
  overlap?: number;
  /** Cap on chunks per document (keeps an index bounded). */
  maxChunks?: number;
}

/**
 * Heading-aware section chunks (procedures, passenger-rights pages): each section is packed to 300–600 tokens with
 * ~15% overlap only inside long prose; small adjacent sections under the same parent are merged (their headings are
 * listed in the breadcrumb). docId = the section, so overlapping parts of one section collapse at retrieval.
 */
export function sectionChunks(base: ChunkBase, sections: Section[], o: SectionChunkOptions): ChunkRecord[] {
  const min = o.minTokens ?? 300;
  const max = o.maxTokens ?? 600;
  const merged: Section[] = [];
  for (const s of sections.map((x) => ({ path: x.path, text: cleanText(x.text) })).filter((x) => x.text)) {
    const prev = merged[merged.length - 1];
    const parent = (p: string[]) => p.slice(0, -1).join(SEP);
    if (
      prev &&
      parent(prev.path) === parent(s.path) &&
      estimateTokens(prev.text) < min &&
      estimateTokens(prev.text) + estimateTokens(s.text) <= max
    ) {
      const last = prev.path[prev.path.length - 1];
      const cur = s.path[s.path.length - 1];
      prev.path = [
        ...prev.path.slice(0, -1),
        last && cur && last !== cur ? `${last}; ${cur}` : (last ?? cur),
      ];
      prev.text = `${prev.text}\n\n${s.text}`;
    } else merged.push({ path: [...s.path], text: s.text });
  }
  const out: ChunkRecord[] = [];
  merged.forEach((s, i) => {
    const header = contextHeader({
      source: o.source,
      path: s.path,
      jurisdiction: base.jurisdiction,
      date: base.date,
    });
    const budget = max - Math.min(estimateTokens(header), 120);
    const parts =
      estimateTokens(s.text) <= budget
        ? [s.text]
        : packUnits(s.text.split(/\n\n+/), { maxTokens: budget, overlap: o.overlap ?? 0.15 });
    out.push(
      ...records(
        { ...base, section: s.path.filter(Boolean).join(SEP) || base.section },
        `${o.docPrefix}-s${String(i + 1).padStart(3, '0')}`,
        header,
        parts,
      ),
    );
  });
  return out.slice(0, o.maxChunks ?? Infinity);
}

/**
 * Split cleaned text into sections at heading lines. `headingLevel(line, prev, next)` returns 1, 2, … for a heading
 * or 0 for body text. Text before the first heading goes into a section with an empty path.
 */
export function splitSections(
  text: string,
  headingLevel: (line: string, prev: string, next: string) => number,
  headingText: (line: string) => string = (l) => l.replace(/\.$/, ''),
): Section[] {
  const lines = text.split('\n');
  const sections: Section[] = [];
  let stack: string[] = [];
  let buf: string[] = [];
  const flush = () => {
    const t = buf.join('\n').trim();
    if (t) sections.push({ path: [...stack], text: t });
    buf = [];
  };
  lines.forEach((line, i) => {
    const t = line.trim();
    const lvl = t ? headingLevel(t, (lines[i - 1] ?? '').trim(), (lines[i + 1] ?? '').trim()) : 0;
    if (lvl > 0) {
      flush();
      const next = stack.slice(0, lvl - 1);
      while (next.length < lvl - 1) next.push('');
      next.push(headingText(t));
      stack = next;
      return;
    }
    buf.push(line);
  });
  flush();
  return sections;
}

// ------------------------------------------------------------------------------------------------ 5. Precedents
export interface Report {
  /** e.g. `asrs-1577181`, `aaib-<slug>` */
  docId: string;
  /** Report id shown in the header, e.g. "ASRS ACN 1577181". */
  reportId: string;
  synopsis?: string;
  aircraftType?: string;
  phase?: string;
  eventType?: string;
  /** Verbatim report text (narratives, bulletin body). */
  text: string;
}

export const REPORT_MAX_TOKENS = 1000;
export const REPORT_PART_TOKENS = 800;

/**
 * One report = one chunk when ≤ ~1,000 tokens; longer reports are split at paragraph/sentence boundaries into
 * ~800-token parts, the header (report id, synopsis, aircraft type, phase, event type) repeated on every part.
 */
export function reportChunks(base: ChunkBase, r: Report, opts: { maxParts?: number } = {}): ChunkRecord[] {
  const facts = [
    r.aircraftType && `Aircraft: ${r.aircraftType}`,
    r.phase && `Phase: ${r.phase}`,
    r.eventType && `Event: ${r.eventType}`,
  ].filter(Boolean);
  const header = contextHeader({
    source: r.reportId,
    path: [],
    jurisdiction: base.jurisdiction,
    date: base.date,
    extra: [r.synopsis && `Synopsis: ${r.synopsis}`, facts.length ? facts.join('; ') : undefined],
  });
  const text = cleanText(r.text);
  const parts =
    estimateTokens(text) + estimateTokens(header) <= REPORT_MAX_TOKENS
      ? [text]
      : packUnits(text.split(/\n\n+/), { maxTokens: REPORT_PART_TOKENS });
  const meta: Record<string, string> = { ...base.meta };
  if (r.phase) meta.phase = r.phase;
  if (r.aircraftType) meta.aircraftType = r.aircraftType;
  if (parts.length > 1) meta.parts = String(Math.min(parts.length, opts.maxParts ?? Infinity));
  return records({ ...base, meta }, r.docId, header, parts.slice(0, opts.maxParts ?? Infinity));
}

// ------------------------------------------------------------------------------------------------ report
function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

/** Per-collection chunk counts and token distribution (tokens of header + text, i.e. what is embedded). */
export function chunkingReport(chunks: ChunkRecord[]): Record<string, ChunkStats> {
  const by = new Map<KnowledgeCollection, ChunkRecord[]>();
  for (const c of chunks) {
    const l = by.get(c.collection) ?? [];
    l.push(c);
    by.set(c.collection, l);
  }
  const out: Record<string, ChunkStats> = {};
  for (const [col, list] of [...by].sort((a, b) => a[0].localeCompare(b[0]))) {
    const toks = list.map((c) => estimateTokens(indexText(c))).sort((a, b) => a - b);
    const docCount = new Map<string, number>();
    for (const c of list) docCount.set(c.docId ?? c.chunkId, (docCount.get(c.docId ?? c.chunkId) ?? 0) + 1);
    const total = toks.reduce((a, x) => a + x, 0);
    out[col] = {
      chunks: list.length,
      docs: docCount.size,
      splitDocs: [...docCount.values()].filter((n) => n > 1).length,
      tokens: {
        total,
        mean: Math.round(total / list.length),
        p10: percentile(toks, 0.1),
        p50: percentile(toks, 0.5),
        p90: percentile(toks, 0.9),
        max: toks[toks.length - 1],
      },
    };
  }
  return out;
}
