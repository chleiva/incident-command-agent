/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Jurisdiction, ToolDefinition } from '@ica/schema';
import { knowledgeInput, knowledgeSearch } from './_shared';

export const search_passenger_rights: ToolDefinition<{
  query: string;
  k?: number;
  jurisdiction?: Jurisdiction;
}> = {
  name: 'search_passenger_rights',
  description:
    'Search passenger-rights law and guidance: EU Regulation 261/2004 (articles on delay, cancellation, care, re-routing, compensation) and UK CAA passenger pages (UK261). Filter by jurisdiction EU or UK. Returns documents with citations; cite them for every rights statement.',
  inputSchema: knowledgeInput(true),
  tier: 'execute',
  system: 'knowledge',
  roles: ['passenger'],
  mutates: false,
  handler: (input, ctx) => knowledgeSearch(ctx, input, ['passenger_rights']),
};
