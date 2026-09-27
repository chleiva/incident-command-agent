/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Blocks any term listed in the git-ignored config/private-words.txt (client, airline or consultancy names).
 *   node scripts/hygiene/wordlist-check.mjs            # working tree (tracked + untracked, not ignored)
 *   node scripts/hygiene/wordlist-check.mjs --staged   # staged content (pre-commit)
 *   node scripts/hygiene/wordlist-check.mjs --history  # every commit message and patch (git log -p --all)
 * The word list itself is never printed in full; only the matching term and location.
 */
import { readFileSync } from 'node:fs';
import { git, privateWords, repoFiles, stagedFiles, wordMatchers } from './lib.mjs';

const mode = process.argv.includes('--staged')
  ? 'staged'
  : process.argv.includes('--history')
    ? 'history'
    : 'tree';
const words = privateWords();
if (!words.length) {
  console.log('word-list check: config/private-words.txt absent or empty (nothing to check)');
  process.exit(0);
}
const matchers = wordMatchers(words);
const hits = [];
const SKIP =
  /^(config\/private-words\.txt|package-lock\.json)$|\.(png|jpg|jpeg|gif|webp|ico|pdf|woff2?|ttf|zip|gz|parquet)$/i;

function scan(label, text) {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const { word, re } of matchers) if (re.test(lines[i])) hits.push(`${label}:${i + 1}: '${word}'`);
  }
}

if (mode === 'history') {
  let log = '';
  try {
    log = git(['log', '-p', '--all', '--no-color', '--format=commit %H%n%an <%ae>%n%B']);
  } catch {
    log = ''; // no commits yet
  }
  scan('git-history', log);
} else {
  const files = mode === 'staged' ? stagedFiles() : repoFiles();
  for (const f of files) {
    if (SKIP.test(f)) continue;
    let text;
    try {
      text = mode === 'staged' ? git(['show', `:${f}`]) : readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    scan(f, text);
    for (const { word, re } of matchers) if (re.test(f)) hits.push(`${f}: file name contains '${word}'`);
  }
}

if (hits.length) {
  console.error(`word-list check FAILED (${mode}): private terms found`);
  for (const h of hits.slice(0, 200)) console.error(`  ${h}`);
  process.exit(1);
}
console.log(`word-list check OK (${mode}, ${words.length} terms)`);
