/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Jurisdiction, ToolDefinition } from '@ica/schema';
import { knowledgeInput, knowledgeSearch } from './_shared';

export const search_procedure: ToolDefinition<{ query: string; k?: number; jurisdiction?: Jurisdiction }> = {
  name: 'search_procedure',
  description:
    'Search ground-operations procedures and rules (FAA AC 150/5210-20A, UK CAA CAP 642, Airbus Safety First ground-ops articles, EASA rules on MEL, FTL and commander responsibilities). Optional jurisdiction filter (EU, UK, US). Returns documents with citations; cite them for any procedural claim.',
  inputSchema: knowledgeInput(true),
  tier: 'execute',
  system: 'knowledge',
  roles: ['ground', 'maintenance'],
  mutates: false,
  handler: (input, ctx) => knowledgeSearch(ctx, input, ['procedure', 'rules']),
};
