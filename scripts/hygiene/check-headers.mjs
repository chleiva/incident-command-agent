/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Licence-header check: every .ts/.tsx/.mjs/.js source file must start with the Apache-2.0 header.
 *   node scripts/hygiene/check-headers.mjs            # whole tree
 *   node scripts/hygiene/check-headers.mjs --fix      # add missing headers
 *   node scripts/hygiene/check-headers.mjs --files a b  # given files (lint-staged)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { HEADER, SOURCE_EXT, hasHeader, repoFiles } from './lib.mjs';

const args = process.argv.slice(2);
const fix = args.includes('--fix');
const filesIdx = args.indexOf('--files');
const files = (
  filesIdx >= 0 ? args.slice(filesIdx + 1).filter((a) => !a.startsWith('--')) : repoFiles()
).filter(
  (f) => SOURCE_EXT.test(f) && !/(^|\/)(node_modules|dist|cdk\.out|coverage|storybook-static)\//.test(f),
);

const missing = [];
for (const f of files) {
  const text = readFileSync(f, 'utf8');
  if (hasHeader(text)) continue;
  if (fix) {
    const shebang = text.startsWith('#!') ? text.slice(0, text.indexOf('\n') + 1) : '';
    writeFileSync(f, shebang + HEADER + text.slice(shebang.length));
  } else missing.push(f);
}

if (missing.length) {
  console.error(`Missing Apache-2.0 licence header in ${missing.length} file(s):`);
  for (const f of missing) console.error(`  ${f}`);
  console.error('Run `npm run format` (adds headers) or copy the header from any existing source file.');
  process.exit(1);
}
console.log(`licence headers OK (${files.length} files)`);
