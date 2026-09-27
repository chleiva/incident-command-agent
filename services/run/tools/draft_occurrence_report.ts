/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ToolDefinition } from '@ica/schema';
import { addReportDraft } from '../systems/record/index';
import { fromResult, obj } from './_shared';

export const REPORT_BODY = {
  type: 'string',
  minLength: 50,
  maxLength: 6000,
  description:
    'Factual draft: what, where, when, aircraft, damage/defect, actions, decisions and who took them.',
} as const;

export const draft_occurrence_report: ToolDefinition<{ body: string }> = {
  name: 'draft_occurrence_report',
  description:
    'Draft a mandatory occurrence report (Reg. (EU) 376/2014) for a named human reporter to review and file within 72 h. Software only drafts: the draft is tagged forHumanReporter and AI-drafted. Stick to facts from the timeline and tools.',
  inputSchema: obj({ body: REPORT_BODY }, ['body']),
  tier: 'execute',
  system: 'record',
  roles: ['record'],
  mutates: true,
  outputScreen: { kind: 'report', fields: ['/body'] },
  handler: async (input, ctx) =>
    fromResult(
      addReportDraft(ctx.state, { kind: 'occurrence', body: input.body }, ctx.simMinute, ctx.rng),
      (r) => ({
        report: { id: r.id, kind: r.kind, status: r.status, forHumanReporter: true, aiDrafted: true },
      }),
    ),
};
