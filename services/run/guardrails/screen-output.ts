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
export const PASSENGER_URL_ALLOWLIST = ['northwindair.example'];
/** Domains a report or techlog may cite (the open knowledge sources, spec §9). */
export const REPORT_URL_ALLOWLIST = [
  'northwindair.example',
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

/** Status-like claims in a text (empty when clean). */
export function screenStatusClaims(text: string): OutputFinding[] {
  const findings: OutputFinding[] = [];
  for (const [name, re] of STATUS_CLAIM_RES) {
    const m = re.exec(text);
    if (m) findings.push({ pattern: name, excerpt: excerpt(text, m.index, m[0].length) });
  }
  return findings;
}

/** Replace status-like claims with a neutral marker (last resort after the agent failed to redraft). */
export function redactStatusClaims(text: string): string {
  let out = text;
  for (const [, re] of STATUS_CLAIM_RES)
    out = out.replace(new RegExp(re.source, 'gi'), '[status for certifying staff to decide]');
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
