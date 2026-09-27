/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * `npm run scenarios:push [-- --dry-run]`: validates every `scenarios/private/*.json` (git-ignored) and writes it to
 * the deployed table as a private scenario. Invalid files are reported and skipped; the exit code is non-zero if
 * any file failed.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { validateScenario, type Scenario } from '@ica/schema';
import { DynamoStore } from '@ica/store';
import {
  REPO_ROOT,
  awsRegion,
  fail,
  getStackOutputs,
  isMain,
  loadDotEnv,
  requireOutput,
  stackName,
} from './lib';

export function loadPrivateScenarios(dir: string): {
  ok: Scenario[];
  errors: { file: string; errors: string[] }[];
} {
  const ok: Scenario[] = [];
  const errors: { file: string; errors: string[] }[] = [];
  if (!existsSync(dir)) return { ok, errors };
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    } catch {
      errors.push({ file, errors: ['not valid JSON'] });
      continue;
    }
    const v = validateScenario({ ...(parsed as object), visibility: 'private' });
    if (v.ok) ok.push(v.value);
    else errors.push({ file, errors: v.errors });
  }
  return { ok, errors };
}

async function main() {
  loadDotEnv();
  const dir = join(REPO_ROOT, 'scenarios/private');
  const { ok, errors } = loadPrivateScenarios(dir);
  for (const e of errors) console.error(`✖ ${e.file}: ${e.errors.slice(0, 5).join('; ')}`);
  if (!ok.length) fail(errors.length ? 'no valid private scenarios to push' : `no scenarios in ${dir}`);
  if (process.argv.includes('--dry-run')) {
    console.log(`✔ ${ok.length} valid: ${ok.map((s) => s.id).join(', ')} (dry run)`);
    return;
  }
  const region = awsRegion();
  const stack = stackName('Data');
  const tableName = requireOutput(await getStackOutputs(stack, { region }), 'TableName', stack);
  const store = new DynamoStore({ tableName, region });
  for (const s of ok) {
    await store.putScenario(s);
    console.log(`✔ pushed ${s.id} (private)`);
  }
  if (errors.length) process.exit(1);
}

if (isMain(import.meta.url)) {
  main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
}
