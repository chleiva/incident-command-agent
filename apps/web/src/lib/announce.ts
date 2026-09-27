/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Plain-language text for everything a screen reader hears or a toast/narrator shows (demo review 2: the live region
 * read "Request decision is reserved for humans; nothing changed" and a raw `send_passenger_message {…}`).
 *
 * - `plainText`: a last line of defence over any text: tool names become their plain labels (`TOOL_LABEL`), any other
 *   snake_case word becomes words, JSON objects/arrays are dropped.
 * - `approvalPhrase`: a decision in words: the question for `request_decision`, else the action's headline
 *   ("Proposed a passenger message (sms) to 2 passenger groups"). The backend's summary is used only when it is
 *   already plain.
 * - `blockedPhrase`: a guardrail block by layer (only the tier gate is "reserved for a person").
 */
import type { ProjectedApproval } from '@ica/schema/browser';
import { headline, TOOL_LABEL, toolLabel } from '../agents/headline';

const SNAKE = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;
const HAS_SNAKE = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/;

/** Remove JSON objects/arrays (balanced braces/brackets, strings respected); unbalanced tails are dropped too. */
function stripJson(text: string): string {
  let out = '';
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (depth > 0) {
      if (inString) {
        if (c === '\\') i++;
        else if (c === '"') inString = false;
      } else if (c === '"') inString = true;
      else if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') depth--;
      continue;
    }
    // A bracket opens JSON only when it looks like it ({" / {} / [{ / [" / [] / a bare trailing opener).
    if ((c === '{' || c === '[') && /^(\{\s*("|\}|$)|\[\s*("|\{|\]|$))/.test(text.slice(i, i + 3))) {
      depth = 1;
      inString = false;
      continue;
    }
    out += c;
  }
  return out;
}

/** Any text → plain words: no tool names, no snake_case, no JSON. */
export function plainText(text: string | null | undefined): string {
  if (!text) return '';
  return stripJson(String(text))
    .replace(SNAKE, (w) => (TOOL_LABEL[w] ? toolLabel(w) : w.replace(/_/g, ' ')))
    .replace(/\s+([,.;:])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .replace(/[\s:;,—-]+$/, '')
    .trim();
}

/** True when a backend summary is not fit to be read out (a tool name, JSON, snake_case). */
export function looksRaw(text: string | null | undefined): boolean {
  if (!text) return true;
  return /[{}[\]]/.test(text) || HAS_SNAKE.test(text);
}

/** A pending decision in words (the question, or the proposed action's headline). */
export function approvalPhrase(a: Pick<ProjectedApproval, 'tool' | 'args' | 'summary'>): string {
  const summary = a.summary?.trim() ?? '';
  if (a.tool === 'request_decision') {
    const q = typeof a.args?.question === 'string' ? a.args.question : summary;
    return plainText(q) || 'Choose between options';
  }
  return looksRaw(summary) ? headline(a.tool, a.args) : plainText(summary);
}

/** A guardrail block in words, by layer (only the tier gate means "reserved for a person"). */
export function blockedPhrase(tool: string | undefined, layer: string): string {
  const what = tool ? toolLabel(tool) : 'an action';
  switch (layer) {
    case 'tier':
      return `Blocked — only a person may ${what}; nothing changed`;
    case 'arg_validation':
      return `Sent back to the agent to fix: ${what}; nothing changed`;
    case 'ref_validation':
      return `Sent back to the agent: ${what} named something unknown; nothing changed`;
    case 'output_screen':
      return `Held by screening: ${what}; nothing was sent`;
    default:
      return `Blocked: ${what}; nothing changed`;
  }
}
