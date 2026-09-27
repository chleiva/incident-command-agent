/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** A kb:build source step. Each step is independent; a failing step warns and the build continues. */
import { readFileSync } from 'node:fs';
import * as cheerio from 'cheerio';
import { extractText, getDocumentProxy } from 'unpdf';
import type { KnowledgeCollection } from '@ica/schema';
import type { ChunkRecord } from '../../src/format';
import { chunkText, cleanText } from '../../src/text';

export interface SourceStep {
  /** Stable step id (also the cache file name under data/raw/chunks/). */
  id: string;
  collection: KnowledgeCollection;
  licence: string;
  /** Skipped unless this returns true (e.g. FSF needs KB_INCLUDE_FSF=true). */
  enabled?: () => boolean;
  run(): Promise<ChunkRecord[]>;
}

/** Text of every page of a PDF on disk. */
export async function pdfPages(path: string): Promise<string[]> {
  const pdf = await getDocumentProxy(new Uint8Array(readFileSync(path)));
  const { text } = await extractText(pdf, { mergePages: false });
  // Re-flow hard line wraps inside sentences (a wrap not after punctuation, before a lower-case word).
  return (text as string[]).map((t) => t.replace(/([^.:;!?\n])\n(?=[a-z(])/g, '$1 '));
}

/** Readable text of an HTML fragment (block elements become paragraph breaks). */
export function htmlToText(html: string, selector?: string): string {
  const $ = cheerio.load(html);
  $('script, style, nav, header, footer, noscript, form, svg, iframe, button').remove();
  const root = selector ? $(selector).first() : $('body');
  root.find('p, li, h1, h2, h3, h4, h5, h6, tr, div, br, section, article').each((_, el) => {
    $(el).append('\n\n');
  });
  return cleanText(root.text());
}

/** Build chunk records from a long text with shared metadata. */
export function makeChunks(
  base: Omit<ChunkRecord, 'chunkId' | 'text'>,
  text: string,
  opts: { idPrefix: string; maxChunks?: number; targetTokens?: number } = { idPrefix: base.sourceId },
): ChunkRecord[] {
  const parts = chunkText(text, opts.targetTokens ?? 500).slice(0, opts.maxChunks ?? Infinity);
  return parts.map((t, i) => ({ ...base, chunkId: `${opts.idPrefix}#${i + 1}`, text: t }));
}

export function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(-60)
    .replace(/^-/, '');
}
