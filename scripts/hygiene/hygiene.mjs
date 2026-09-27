/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * npm run hygiene — the full open-source hygiene scan (run before any public push):
 *   licence headers, private word list over the tree AND git history, forbidden files in the index/history,
 *   and gitleaks over the tree + history when installed.
 */
import { spawnSync } from 'node:child_process';
import { git, which } from './lib.mjs';

const results = [];
function step(name, cmd, args) {
  console.log(`\n── ${name}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit' });
  results.push([name, r.status === 0]);
}

step('licence headers', process.execPath, ['scripts/hygiene/check-headers.mjs']);
step('word list (tree)', process.execPath, ['scripts/hygiene/wordlist-check.mjs']);
step('word list (history)', process.execPath, ['scripts/hygiene/wordlist-check.mjs', '--history']);

console.log('\n── forbidden files (index and history)');
const FORBIDDEN =
  /(^|\/)\.env$|^\.env\.(?!example$)|^config\/brand\.local\.json$|^config\/private-words\.txt$|^scenarios\/private\/|^data\/raw\//;
let names = '';
try {
  names = git(['log', '--all', '--name-only', '--format=']) + '\n' + git(['ls-files']);
} catch {
  names = git(['ls-files']);
}
const forbidden = [...new Set(names.split('\n').filter((f) => f && FORBIDDEN.test(f)))];
if (forbidden.length) {
  console.error('Forbidden files are tracked or appear in history:');
  for (const f of forbidden) console.error(`  ${f}`);
}
results.push(['forbidden files', forbidden.length === 0]);
if (!forbidden.length) console.log('none');

if (which('gitleaks')) {
  step('gitleaks (history)', 'gitleaks', ['detect', '--source', '.', '--redact', '--no-banner']);
  step('gitleaks (working tree)', 'gitleaks', [
    'detect',
    '--source',
    '.',
    '--no-git',
    '--redact',
    '--no-banner',
  ]);
} else {
  console.warn('\nWARNING: gitleaks not installed; secret scan skipped (CI runs it).');
}

console.log('\n── summary');
for (const [name, ok] of results) console.log(`${ok ? '✓' : '✗'} ${name}`);
process.exit(results.every(([, ok]) => ok) ? 0 : 1);
