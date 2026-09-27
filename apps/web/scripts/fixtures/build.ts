/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * `npm run fixtures -w @ica/web`: regenerates the mock-mode recordings in `src/mocks/fixtures/`.
 * Deterministic; the output is validated against the shared schema in `src/mocks/fixtures.test.ts`.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';
import { buildS01Agent, buildS01Baseline, s01Scenario } from './s01';
import { buildS04Agent, buildS04Baseline, s04Scenario } from './s04';

const outDir = fileURLToPath(new URL('../../src/mocks/fixtures/', import.meta.url));

async function write(name: string, data: unknown) {
  const path = `${outDir}${name}`;
  const opts = { ...((await resolveConfig(path)) ?? {}), filepath: path };
  writeFileSync(path, await format(JSON.stringify(data), opts));
  const n = Array.isArray(data) ? ` (${data.length} events)` : '';
  console.log(`wrote apps/web/src/mocks/fixtures/${name}${n}`);
}

await write('s01.scenario.json', s01Scenario);
await write('s01.agent.events.json', buildS01Agent());
await write('s01.baseline.events.json', buildS01Baseline());
await write('s04.scenario.json', s04Scenario);
await write('s04.agent.events.json', buildS04Agent());
await write('s04.baseline.events.json', buildS04Baseline());
