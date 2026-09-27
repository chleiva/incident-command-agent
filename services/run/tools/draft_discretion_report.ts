/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ToolDefinition } from '@ica/schema';
import { addReportDraft } from '../systems/record/index';
import { REPORT_BODY } from './draft_occurrence_report';
import { fromResult, obj } from './_shared';

export const draft_discretion_report: ToolDefinition<{ body: string }> = {
  name: 'draft_discretion_report',
  description:
    "Draft a commander's discretion report (ORO.FTL.205(f)) for the commander to complete if they choose to use discretion. It records facts only (FDP figures, delays, reasons); it never decides or recommends exceeding limits. Tagged for a human reporter and AI-drafted.",
  inputSchema: obj({ body: REPORT_BODY }, ['body']),
  tier: 'execute',
  system: 'record',
  roles: ['record'],
  mutates: true,
  outputScreen: { kind: 'report', fields: ['/body'] },
  handler: async (input, ctx) =>
    fromResult(
      addReportDraft(ctx.state, { kind: 'discretion', body: input.body }, ctx.simMinute, ctx.rng),
      (r) => ({
        report: { id: r.id, kind: r.kind, status: r.status, forHumanReporter: true, aiDrafted: true },
      }),
    ),
};
