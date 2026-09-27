/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Pre-commit hook (installed by simple-git-hooks on `npm install`):
 *   1. gitleaks protect --staged, if the binary exists; otherwise warn and continue (CI always runs gitleaks);
 *   2. the private word-list check over staged content;
 *   3. refuse to commit files that must never be committed.
 */
import { spawnSync } from 'node:child_process';
import { stagedFiles, which } from './lib.mjs';

let failed = false;

if (which('gitleaks')) {
  const r = spawnSync('gitleaks', ['protect', '--staged', '--redact', '--no-banner'], { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error('gitleaks found potential secrets in staged changes.');
    failed = true;
  }
} else {
  console.warn(
    'WARNING: gitleaks not installed; skipping local secret scan (CI runs it). https://github.com/gitleaks/gitleaks',
  );
}

const words = spawnSync(process.execPath, ['scripts/hygiene/wordlist-check.mjs', '--staged'], {
  stdio: 'inherit',
});
if (words.status !== 0) failed = true;

const NEVER = [
  /^\.env(\..*)?$/,
  /(^|\/)\.env$/,
  /^config\/brand\.local\.json$/,
  /^config\/private-words\.txt$/,
  /^scenarios\/private\//,
  /^data\/raw\//,
];
const bad = stagedFiles().filter((f) => f !== '.env.example' && NEVER.some((re) => re.test(f)));
if (bad.length) {
  console.error('These files must never be committed:');
  for (const f of bad) console.error(`  ${f}`);
  failed = true;
}

process.exit(failed ? 1 : 0);
