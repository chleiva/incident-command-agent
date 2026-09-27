/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** Produces the committed generated artefacts (formatted with the repo's Prettier config). */
import { format, resolveConfig } from 'prettier';
import { renderTokensCss } from './css';
import { renderFigmaTokens } from './figma';

export const GENERATED_FILES = ['tokens.css', 'figma-tokens.json'] as const;
export type GeneratedFile = (typeof GENERATED_FILES)[number];

export async function renderGenerated(packageDir: string): Promise<Record<GeneratedFile, string>> {
  const cssPath = `${packageDir}/tokens.css`;
  const jsonPath = `${packageDir}/figma-tokens.json`;
  const cssOpts = { ...((await resolveConfig(cssPath)) ?? {}), filepath: cssPath };
  const jsonOpts = { ...((await resolveConfig(jsonPath)) ?? {}), filepath: jsonPath };
  return {
    'tokens.css': await format(renderTokensCss(), cssOpts),
    'figma-tokens.json': await format(JSON.stringify(renderFigmaTokens()), jsonOpts),
  };
}
