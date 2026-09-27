/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Jurisdiction, ToolDefinition } from '@ica/schema';
import { knowledgeInput, knowledgeSearch } from './_shared';

export const search_mel: ToolDefinition<{ query: string; k?: number }> = {
  name: 'search_mel',
  description:
    'Search the MEL stand-in (FAA A320 MMEL, quoted verbatim): item number, repair category and dispatch conditions. Query with the system or item, e.g. "APU inoperative" or "49-10-01". Returns documents with citations; quote the citation when you state any MEL condition. Finding an item does NOT authorise a deferral: only certifying staff decide.',
  inputSchema: knowledgeInput(false),
  tier: 'execute',
  system: 'knowledge',
  roles: ['maintenance'],
  mutates: false,
  handler: (input, ctx) =>
    knowledgeSearch(ctx, { ...input, jurisdiction: undefined as Jurisdiction | undefined }, ['mel']),
};
