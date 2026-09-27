/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** Shared helpers for the hygiene scripts (no dependencies). */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

export const HEADER_LINES = [
  '/*',
  ' * Copyright 2026 Incident Command Agent contributors',
  ' * SPDX-License-Identifier: Apache-2.0',
  ' */',
];
export const HEADER = HEADER_LINES.join('\n') + '\n';
export const SOURCE_EXT = /\.(ts|tsx|mts|cts|mjs|cjs|js|jsx)$/;

export function git(args, opts = {}) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
}

/** Tracked + untracked-but-not-ignored files. */
export function repoFiles() {
  return git(['ls-files', '-co', '--exclude-standard', '-z'])
    .split('\0')
    .filter(Boolean)
    .filter((f) => existsSync(f));
}

export function stagedFiles() {
  return git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']).split('\0').filter(Boolean);
}

export function hasHeader(text) {
  const body = text.startsWith('#!') ? text.slice(text.indexOf('\n') + 1) : text;
  return (
    body.startsWith(HEADER_LINES[0]) && body.slice(0, 400).includes('SPDX-License-Identifier: Apache-2.0')
  );
}

export function which(bin) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { encoding: 'utf8' });
  return r.status === 0;
}

/** Terms from the git-ignored config/private-words.txt (one per line, # comments). Empty if absent. */
export function privateWords(path = 'config/private-words.txt') {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

export function wordMatchers(words) {
  return words.map((w) => ({
    word: w,
    re: new RegExp(`(^|[^\\p{L}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}])`, 'iu'),
  }));
}
