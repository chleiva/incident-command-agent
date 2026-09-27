/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Plain-language glossary (task 06 §1.11): `glossary.json` keyed by term, each `{definition, inline, aliases[]}`.
 * `definition` is the one-line tooltip; `inline` replaces the term in plain-language mode. Pure helpers only.
 */
import data from './glossary.json';

export interface GlossaryEntry {
  /** The glossary key, e.g. "MEL" or "OCC / ICC". */
  term: string;
  definition: string;
  inline: string;
  aliases: string[];
}

export const GLOSSARY: Record<string, GlossaryEntry> = Object.fromEntries(
  Object.entries(data as Record<string, Omit<GlossaryEntry, 'term'>>).map(([term, e]) => [
    term,
    { term, ...e },
  ]),
);

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Alias (lower case) → glossary key. */
const BY_ALIAS = new Map<string, string>();
for (const e of Object.values(GLOSSARY)) {
  BY_ALIAS.set(e.term.toLowerCase(), e.term);
  for (const a of e.aliases) BY_ALIAS.set(a.toLowerCase(), e.term);
}

/** Longest aliases first, so "reactionary delay" wins over "reactionary". Whole words, case-insensitive. */
const ALIAS_RE = new RegExp(
  `(?<![\\w-])(${[...BY_ALIAS.keys()]
    .sort((a, b) => b.length - a.length)
    .map(escape)
    .join('|')})(?![\\w-])`,
  'gi',
);

/** The entry for a glossary key or any alias (case-insensitive). */
export function lookup(termOrAlias: string): GlossaryEntry | undefined {
  const key = BY_ALIAS.get(termOrAlias.toLowerCase());
  return key ? GLOSSARY[key] : undefined;
}

export type GlossarySegment = string | { text: string; entry: GlossaryEntry };

/**
 * Split free text into plain strings and glossary matches: whole-word, case-insensitive, and only the FIRST
 * occurrence of each glossary entry per block (later ones stay plain text).
 */
export function segmentText(text: string): GlossarySegment[] {
  const out: GlossarySegment[] = [];
  const seen = new Set<string>();
  let last = 0;
  for (const m of text.matchAll(ALIAS_RE)) {
    const entry = lookup(m[0]);
    if (!entry || seen.has(entry.term)) continue;
    seen.add(entry.term);
    if (m.index! > last) out.push(text.slice(last, m.index));
    out.push({ text: m[0], entry });
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
