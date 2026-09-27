/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** Write committed JSON/Markdown artefacts already formatted by Prettier, so `npm run lint` stays green. */
import { writeFile } from 'node:fs/promises';
import { format, resolveConfig } from 'prettier';

export async function writePretty(path: string, content: string, parser: 'json' | 'markdown'): Promise<void> {
  const options = (await resolveConfig(path)) ?? {};
  await writeFile(path, await format(content, { ...options, parser }));
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await writePretty(path, JSON.stringify(value, null, 2), 'json');
}
