/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Jurisdiction, ToolDefinition } from '@ica/schema';
import { knowledgeInput, knowledgeSearch } from './_shared';

export const search_precedents: ToolDefinition<{ query: string; k?: number; jurisdiction?: Jurisdiction }> = {
  name: 'search_precedents',
  description:
    'Search real occurrence narratives: NASA ASRS reports (US, de-identified, unverified) and UK AAIB reports. Use them to make a scenario realistic; cite them by sourceId (e.g. "ASRS ACN 1234567") and never invent report ids. Returns documents with citations.',
  inputSchema: knowledgeInput(true),
  tier: 'execute',
  system: 'knowledge',
  roles: ['author'],
  mutates: false,
  handler: (input, ctx) => knowledgeSearch(ctx, input, ['precedent']),
};
