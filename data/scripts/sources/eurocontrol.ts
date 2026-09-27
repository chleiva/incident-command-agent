/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * EUROCONTROL Standard Inputs for Economic Analyses — cost of delay chapter → data/params/delay-cost.json.
 * The tables are copied as published (with their source note); the KPI model's defaults stay the spec's
 * (€100/min, reactionary factor 1.8) and cite this file as their reference.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';
import { download, writePrettyJson } from '../lib';

export const DELAY_COST_URL =
  'https://ansperformance.eu/economics/cba/standard-inputs/latest/chapters/cost_of_delay.html';
export const DELAY_COST_FILE = fileURLToPath(new URL('../../params/delay-cost.json', import.meta.url));

export async function buildDelayCostParams(): Promise<number> {
  const path = await download(DELAY_COST_URL, 'eurocontrol/cost_of_delay.html', { minBytes: 5000 });
  const $ = cheerio.load(readFileSync(path, 'utf8'));
  const tables: { caption?: string; headers: string[][]; rows: string[][]; note?: string }[] = [];
  $('table').each((_, t) => {
    const $t = $(t);
    const headers: string[][] = [];
    $t.find('thead tr').each((_, tr) => {
      headers.push(
        $(tr)
          .find('th,td')
          .map((_, c) => $(c).text().replace(/\s+/g, ' ').trim())
          .get(),
      );
    });
    const rows: string[][] = [];
    $t.find('tbody tr').each((_, tr) => {
      rows.push(
        $(tr)
          .find('th,td')
          .map((_, c) => $(c).text().replace(/\s+/g, ' ').trim())
          .get(),
      );
    });
    const note = $t.find('tfoot').text().replace(/\s+/g, ' ').trim() || undefined;
    const caption = $t.find('caption').text().replace(/\s+/g, ' ').trim() || undefined;
    if (rows.length) tables.push({ caption, headers, rows, note });
  });
  if (!tables.length) throw new Error('no tables found in the EUROCONTROL cost-of-delay chapter');
  await writePrettyJson(DELAY_COST_FILE, {
    source: 'EUROCONTROL Standard Inputs for Economic Analyses — Cost of delay (latest edition)',
    url: DELAY_COST_URL,
    retrievedAt: new Date().toISOString().slice(0, 10),
    licence: 'EUROCONTROL; free to use with attribution',
    attribution: 'Source: EUROCONTROL Standard Inputs for Economic Analyses (ansperformance.eu).',
    kpiDefaults: {
      eurPerMinute: 100,
      reactionaryFactor: 1.8,
      note:
        'Spec §8 defaults used by the KPI model (a round figure for a narrow-body at the gate). The published ' +
        'tables below are the reference for overriding them per scenario (kpiParams).',
    },
    tables,
  });
  return tables.length;
}
