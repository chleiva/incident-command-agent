/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** Writes packages/schema/scenario.schema.json from the TypeBox source of truth. */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderScenarioSchemaFile } from '../src/scenario';

const out = fileURLToPath(new URL('../scenario.schema.json', import.meta.url));
writeFileSync(out, renderScenarioSchemaFile());
console.log(`wrote ${out}`);
