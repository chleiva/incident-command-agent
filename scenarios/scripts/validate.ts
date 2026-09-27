/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * npm run scenarios:validate — validates scenarios/public/*.json (and scenarios/private/*.json if present)
 * against scenario.schema.json, checks file name = id, and regenerates scenarios/public/index.gen.ts.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SCENARIO_IDS, validateScenario } from '@ica/schema';
import { INDEX_FILE, PRIVATE_DIR, PUBLIC_DIR, listJson, renderIndex } from './index-gen';

let failed = 0;
function check(dir: string, visibility: 'public' | 'private') {
  for (const f of listJson(dir)) {
    const label = `${visibility}/${f}`;
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    } catch (err) {
      console.error(`✗ ${label}: invalid JSON (${String(err)})`);
      failed++;
      continue;
    }
    const r = validateScenario(data);
    const errors = r.ok ? [] : [...r.errors];
    if (r.ok) {
      if (`${r.value.id}.json` !== f) errors.push(`file name must be ${r.value.id}.json`);
      if (r.value.visibility !== visibility) errors.push(`visibility must be '${visibility}'`);
      if (visibility === 'public' && !(SCENARIO_IDS as readonly string[]).includes(r.value.id)) {
        console.warn(`! ${label}: id is not one of the ten fixed ids in CLAUDE.md`);
      }
    }
    if (errors.length) {
      failed++;
      console.error(`✗ ${label}`);
      for (const e of errors) console.error(`    ${e}`);
    } else console.log(`✓ ${label}`);
  }
}

check(PUBLIC_DIR, 'public');
check(PRIVATE_DIR, 'private');
writeFileSync(INDEX_FILE, renderIndex(listJson(PUBLIC_DIR)));
console.log(`wrote ${INDEX_FILE}`);
if (failed) {
  console.error(`${failed} scenario file(s) invalid`);
  process.exit(1);
}
