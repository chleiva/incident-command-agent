/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** `npm run build -w @ica/ui-tokens`: writes tokens.css and figma-tokens.json next to package.json. */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderGenerated } from '../src/generate';

const dir = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const files = await renderGenerated(dir);
for (const [name, body] of Object.entries(files)) {
  writeFileSync(`${dir}/${name}`, body);
  console.log(`wrote packages/ui-tokens/${name}`);
}
