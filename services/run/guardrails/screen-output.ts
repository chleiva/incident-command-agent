/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Output screening (spec §11 layer 4): passenger messages, techlog drafts and reports are checked before they
 * become proposals or are shown. Blocks secrets, non-allow-listed URLs, legal claims and personal-data patterns.
 */

export type OutputKind = 'passenger_message' | 'techlog' | 'report';

export interface OutputFinding {
  pattern: string;
  excerpt: string;
}

export interface OutputScreenResult {
  ok: boolean;
  findings: OutputFinding[];
}

/** Domains a passenger message may link to (the fictional carrier only). */
export const PASSENGER_URL_ALLOWLIST = ['accentair.example'];
/** Domains a report or techlog may cite (the open knowledge sources, spec §9). */
export const REPORT_URL_ALLOWLIST = [
  'accentair.example',
  'asrs.arc.nasa.gov',
  'nasa.gov',
  'gov.uk',
  'caa.co.uk',
  'faa.gov',
  'easa.europa.eu',
  'eur-lex.europa.eu',
  'eurocontrol.int',
  'airbus.com',
  'safetyfirst.airbus.com',
  'ourairports.com',
  'aviationweather.gov',
  'huggingface.co',
];

const SECRET_RES: [string, RegExp][] = [
  ['secret:anthropic_key', /sk-ant-[A-Za-z0-9_-]{8,}/],
  ['secret:openai_key', /\bsk-(proj-)?[A-Za-z0-9_-]{16,}/],
  ['secret:aws_key', /\bAKIA[0-9A-Z]{16}\b/],
  ['secret:private_key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['secret:bearer', /\bbearer\s+[A-Za-z0-9._-]{20,}/i],
];

const LEGAL_RES: [string, RegExp][] = [
  ['legal:extraordinary_circumstances', /extraordinary\s+circumstances?/i],
  [
    'legal:compensation_denial',
    /\b(not|never|no longer|aren't|are not|isn't|is not)\s+(be\s+)?(entitled|eligible)\s+(to|for)\s+(any\s+)?compensation/i,
  ],
  [
    'legal:compensation_denial',
    /\bno\s+compensation\s+(is\s+|will\s+be\s+)?(due|payable|owed|available|paid)/i,
  ],
  ['legal:force_majeure', /\bforce\s+majeure\b/i],
  ['legal:waiver', /\bwaive[sd]?\s+(your|their|any)\s+(rights?|claims?)\b/i],
  ['legal:beyond_control', /\bbeyond\s+(our|the airline'?s)\s+control\b/i],
];

/**
 * Status-like claims about a defect or the aircraft (task 06 §1.2). A model's interpretation is only ever a
 * provisional reading; deferrability, airworthiness and AOG are decided by certifying staff and recorded with
 * `record_engineering_decision`. Blocked in agent-authored maintenance text (reports, tech-log drafts).
 */
export const STATUS_CLAIM_RES: [string, RegExp][] = [
  ['status:deferrable', /\b(non[- ]?)?deferr?able\b/i],
  ['status:can_be_deferred', /\b(can|could|may|cannot|can't|must not)\s+(not\s+)?be\s+deferred\b/i],
  ['status:airworthy', /\b(un)?airworthy\b/i],
  ['status:aog', /\bAOG\b/i],
  ['status:fit_to_fly', /\b(fit|safe|ok|okay|good)\s+to\s+(fly|dispatch|depart)\b/i],
  ['status:releasable', /\b(is|are|now)\s+(releasable|dispatchable)\b/i],
  ['status:no_go', /\bno[- ]go\s+item\b/i],
];

/**
 * Context that makes a status word NOT the agent's own claim (live run 2): state attributed to a system ("M&E shows",
 * "status flag", "recorded as", "in the rotation feed") or an explicit deferral to certifying staff ("cannot be
 * assumed airworthy", "requires certifying staff", "outside this agent's authority", "not yet declared").
 * Checked in the same clause, BEFORE the status word.
 */
const ATTRIBUTION_BEFORE_RES: RegExp[] = [
  // a system or record as the grammatical source of the state
  /\b(M&E|MNE|OCC|tech[- ]?log|rotation feed|feed|system|records?|status flag|flag|status field|entry)\b[\s\S]{0,60}\b(shows?|showing|shown|records?|recorded|flags?|flagged|lists?|listed|marks?|marked|displays?|displayed|reads?|states?|carries|carrying|holds?)\b/i,
  /\b(status flag|status field|recorded as|shows? as|shown as|listed as|marked as|flagged as|flagged|logged as|displayed as)\b/i,
  /\b(in|on|per|according to|from) (the )?(M&E|MNE|rotation feed|tech[- ]?log|OCC|system|record)\b/i,
  // deferral to certifying staff / explicit non-assertion
  /\b(cannot|can't|can ?not|must not|should not|may not)\s+be\s+(assumed|considered|declared|treated|regarded|presumed|taken)\b/i,
  /\b(not|never|nobody|no one|without)\b[\s\S]{0,30}\b(assum(e|ed|ing)|declar(e|ed|ing)|confirm(ed|ing)?|determin(e|ed|ing)|establish(ed|ing)?|assess(ed|ing)?|decid(e|ed|ing)|certif(y|ied|ying))\b/i,
  /\b(whether|if)\b/i,
  /\b(pending|awaiting|until|requires?|needs?)\b[\s\S]{0,40}\bcertifying (staff|engineer)/i,
];
/** Deferral context AFTER the status word (same clause), unless the clause directly asserts it. */
const ATTRIBUTION_AFTER_RES: RegExp[] = [
  /^[\s\S]{0,40}\b(in|on|per|according to) (the )?(M&E|MNE|rotation feed|tech[- ]?log|OCC|system|record)\b/i,
  /^[\s\S]{0,60}\b(for|by|until|pending|requires?|needs?) (the )?certifying (staff|engineer)/i,
  /^[\s\S]{0,80}\boutside (this|the|my) agent'?s authority\b/i,
];
/**
 * Sentence-level deferral: the sentence hands the determination to certifying staff ("certifying B1 engineer to
 * determine … whether this is rectify, defer … or AOG"). Used only when the clause does not directly assert.
 */
const DEFERRAL_SENTENCE_RES: RegExp[] = [
  /\bcertifying\s+(staff|engineers?|B1|B2|technicians?)\b[\s\S]{0,40}\b(to\s+)?(determine|decide|assess|confirm|release|record|make)\b/i,
  /\b(for|by)\s+certifying\s+(staff|engineers?)\s+to\s+(determine|decide)\b/i,
  /\boutside\s+(this|the|my)\s+agent'?s\s+authority\b/i,
];

/** The clause directly asserts the state: "<subject> is/remains/declared <status>". */
const ASSERTION_BEFORE_RE =
  /\b(is|are|remains?|was|were|be|becomes?|deemed|declared?|now|currently|treated as|considered)\s+(now\s+|currently\s+|still\s+|therefore\s+|an?\s+)*["'“‘]?$/i;

/** The clause around an index: split on sentence punctuation and on clause joiners. */
function clauseAround(
  text: string,
  idx: number,
  len: number,
): { before: string; after: string; sentence: string; sentenceBefore: string } {
  const sentenceStart = Math.max(
    ...['.', '!', '?', ';', '\n', '—', ' - '].map((d) => {
      const i = text.lastIndexOf(d, idx - 1);
      return i < 0 ? 0 : i + d.length;
    }),
  );
  let before = text.slice(sentenceStart, idx);
  const sentenceBefore = before;
  const joiner = /(,|\band\b|\bbut\b|\bso\b|\bwhich\b|\bwhile\b|\bthough\b|\bhowever\b)/gi;
  let last = -1;
  for (const m of before.matchAll(joiner)) last = m.index + m[0].length;
  if (last >= 0) before = before.slice(last);
  const rest = text.slice(idx + len);
  const end = rest.search(/[.!?;\n]|,\s*(and|but|so)\b/);
  const after = end < 0 ? rest : rest.slice(0, end);
  const sentenceEnd = rest.search(/[.!?;\n]/);
  const sentence =
    sentenceBefore + text.slice(idx, idx + len) + (sentenceEnd < 0 ? rest : rest.slice(0, sentenceEnd));
  return { before, after, sentence, sentenceBefore };
}

/** True when a status word at `idx` is attributed to a system or deferred to certifying staff. */
export function isAttributedStatus(text: string, idx: number, len: number): boolean {
  const { before, after, sentence, sentenceBefore } = clauseAround(text, idx, len);
  if (ATTRIBUTION_BEFORE_RES.some((re) => re.test(before))) return true;
  if (ASSERTION_BEFORE_RE.test(before)) return false;
  if (/\bwhether\b/i.test(sentenceBefore)) return true;
  if (DEFERRAL_SENTENCE_RES.some((re) => re.test(sentence))) return true;
  return ATTRIBUTION_AFTER_RES.some((re) => re.test(after));
}

/**
 * Status-like claims in a text (empty when clean). Only the agent's own assertions count: a state quoted from a
 * system ("M&E shows AOG") or explicitly deferred to certifying staff ("cannot be assumed airworthy") passes.
 */
export function screenStatusClaims(text: string): OutputFinding[] {
  const findings: OutputFinding[] = [];
  for (const [name, re] of STATUS_CLAIM_RES) {
    for (const m of text.matchAll(new RegExp(re.source, 'gi'))) {
      if (isAttributedStatus(text, m.index, m[0].length)) continue;
      findings.push({ pattern: name, excerpt: excerpt(text, m.index, m[0].length) });
      break;
    }
  }
  return findings;
}

/** Replace status-like claims with a neutral marker (last resort after the agent failed to redraft). */
export function redactStatusClaims(text: string): string {
  let out = text;
  for (const [, re] of STATUS_CLAIM_RES) {
    const src = out;
    let next = '';
    let at = 0;
    for (const m of src.matchAll(new RegExp(re.source, 'gi'))) {
      // quoted system state and deferrals to certifying staff are kept (see isAttributedStatus)
      if (isAttributedStatus(src, m.index, m[0].length)) continue;
      next += src.slice(at, m.index) + '[status for certifying staff to decide]';
      at = m.index + m[0].length;
    }
    out = next + src.slice(at);
  }
  return out;
}

const PII_RES: [string, RegExp][] = [
  ['pii:email', /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/],
  ['pii:phone', /(\+\d{1,3}[\s-]?\d[\d\s-]{7,}\d)|(\b0\d{9,10}\b)/],
  ['pii:passport', /\b[A-Z]{1,2}\d{7,9}\b/],
  ['pii:card', /\b(?:\d[ -]?){13,16}\b/],
];

function hostOf(url: string): string {
  try {
    return new URL(url.startsWith('http') ? url : `https://${url}`).hostname.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

function allowed(host: string, list: string[]): boolean {
  return list.some((d) => host === d || host.endsWith(`.${d}`));
}

function excerpt(text: string, idx: number, len: number): string {
  return text.slice(Math.max(0, idx - 15), idx + len + 15).slice(0, 80);
}

export function screenOutput(kind: OutputKind, text: string): OutputScreenResult {
  const findings: OutputFinding[] = [];
  const check = (list: [string, RegExp][]) => {
    for (const [name, re] of list) {
      const m = re.exec(text);
      if (m) findings.push({ pattern: name, excerpt: excerpt(text, m.index, m[0].length) });
    }
  };
  check(SECRET_RES);
  if (kind !== 'techlog') check(LEGAL_RES);
  if (kind === 'techlog') findings.push(...screenStatusClaims(text));
  check(PII_RES);
  const allow = kind === 'passenger_message' ? PASSENGER_URL_ALLOWLIST : REPORT_URL_ALLOWLIST;
  for (const m of text.matchAll(/\bhttps?:\/\/[^\s)"'<>]+|\bwww\.[a-z0-9.-]+\.[a-z]{2,}[^\s)"'<>]*/gi)) {
    if (!allowed(hostOf(m[0]), allow)) {
      findings.push({ pattern: 'url:not_allow_listed', excerpt: m[0].slice(0, 80) });
    }
  }
  return { ok: findings.length === 0, findings };
}

/** Resolve a JSON pointer (`/a/b/0`) in a value. */
export function getPointer(obj: unknown, pointer: string): unknown {
  if (pointer === '' || pointer === '/') return obj;
  let cur: unknown = obj;
  for (const raw of pointer.replace(/^\//, '').split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** Collect the text of the fields named by JSON pointers (strings, or arrays of strings). */
export function textAtPointers(args: unknown, pointers: string[]): string[] {
  const out: string[] = [];
  for (const p of pointers) {
    const v = getPointer(args, p);
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) out.push(...v.filter((x): x is string => typeof x === 'string'));
    else if (v && typeof v === 'object') out.push(JSON.stringify(v));
  }
  return out;
}
