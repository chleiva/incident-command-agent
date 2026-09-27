/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ToolDefinition } from '@ica/schema';
import { buildEvidencePack } from '../systems/record/index';
import { S, arrayOf, fromResult, obj } from './_shared';

export const export_evidence_pack: ToolDefinition<{ citedChunkIds?: string[] }> = {
  name: 'export_evidence_pack',
  description:
    'Assemble the evidence pack: timeline, every decision with its approver, messages sent, care and rebookings, report drafts, the latest KPI snapshot, a state snapshot, and the knowledge chunks cited (pass their chunkIds). The UI renders it to PDF. Call it once, at the end.',
  inputSchema: obj({ citedChunkIds: arrayOf(S.id, 40, 0) }),
  tier: 'execute',
  system: 'record',
  roles: ['record'],
  mutates: true,
  handler: async (input, ctx) =>
    fromResult(
      buildEvidencePack(ctx.state, ctx.simMinute, input.citedChunkIds ?? [], ctx.rng, ctx.kpis),
      (p) => ({
        evidencePackId: p.id,
        counts: {
          timeline: p.contents.timeline?.length ?? 0,
          decisions: p.contents.decisions?.length ?? 0,
          messages: p.contents.messages?.length ?? 0,
          reports: p.contents.reports?.length ?? 0,
          citations: p.contents.citations?.length ?? 0,
        },
        kpiSnapshot: ctx.kpis ? { simMinute: ctx.kpis.simMinute } : null,
      }),
    ),
};
