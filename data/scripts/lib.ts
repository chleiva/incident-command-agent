/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** Shared helpers for the kb:build and airports:build scripts (network, caching, polite fetching). */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as prettier from 'prettier';

export const USER_AGENT =
  'IncidentCommandAgent-kb/0.1 (open-source research build; polite, rate-limited; +https://www.apache.org/licenses/LICENSE-2.0)';

export const DATA_DIR = fileURLToPath(new URL('../', import.meta.url));
export const RAW_DIR = fileURLToPath(new URL('../raw/', import.meta.url));
export const INDEX_DIR = fileURLToPath(new URL('../index/', import.meta.url));

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Download `url` to `data/raw/<name>` unless it is already there (resumable, idempotent). */
export async function download(
  url: string,
  name: string,
  opts: { accept?: string; minBytes?: number; timeoutMs?: number } = {},
): Promise<string> {
  const path = RAW_DIR + name;
  if (existsSync(path) && readFileSync(path).byteLength >= (opts.minBytes ?? 1)) return path;
  mkdirSync(dirname(path), { recursive: true });
  const res = await fetch(url, {
    headers: {
      'user-agent': USER_AGENT,
      'accept-language': 'eng, en;q=0.9',
      ...(opts.accept ? { accept: opts.accept } : {}),
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(opts.timeoutMs ?? 180_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength < (opts.minBytes ?? 1))
    throw new Error(`too small (${buf.byteLength} bytes) for ${url}`);
  writeFileSync(path, buf);
  return path;
}

/** Write JSON formatted exactly as the repo's Prettier config would (committed files must pass `prettier --check`). */
export async function writePrettyJson(path: string, value: unknown): Promise<void> {
  const config = (await prettier.resolveConfig(path)) ?? {};
  const text = await prettier.format(JSON.stringify(value), { ...config, parser: 'json', filepath: path });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** Standard-time UTC offset (minutes) for a country/region; DST is applied separately (EU rule). */
export function stdOffsetFor(country: string, region: string): number {
  if (region === 'ES-CN') return 0; // Canary Islands (WET)
  if (region === 'PT-20') return -60; // Azores
  const wet = ['GB', 'IE', 'PT', 'IS', 'FO', 'IM', 'JE', 'GG'];
  const eet = ['GR', 'CY', 'FI', 'EE', 'LV', 'LT', 'BG', 'RO', 'UA', 'MD'];
  if (country === 'IS') return 0;
  if (wet.includes(country)) return 0;
  if (eet.includes(country)) return 120;
  if (country === 'TR' || country === 'BY' || country === 'RU') return 180;
  return 60;
}
