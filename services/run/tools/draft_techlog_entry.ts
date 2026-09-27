/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ToolDefinition } from '@ica/schema';
import { addTechlogEntry } from '../systems/mne/index';
import { S, approverOf, fromResult, obj, requireApproval } from './_shared';

export const draft_techlog_entry: ToolDefinition<{ tail: string; text: string; defectId?: string }> = {
  name: 'draft_techlog_entry',
  description:
    'Propose a tech-log entry (defect description and actions so far) for a human to approve. Factual, no dispatch decision, no MEL deferral wording. The entry is stored as AI-drafted once approved.',
  inputSchema: obj(
    { tail: S.tail, text: { type: 'string', minLength: 10, maxLength: 1200 }, defectId: S.id },
    ['tail', 'text'],
  ),
  tier: 'propose',
  system: 'mne',
  roles: ['maintenance'],
  mutates: true,
  approvalScope: 'Storing this tech-log text as an approved, AI-drafted entry.',
  approvalExclusions: ['Any deferral, release or dispatch decision'],
  defaultUnresolvedChecks: ["Wording checked against the engineer's findings"],
  outputScreen: { kind: 'techlog', fields: ['/text'] },
  refs: [
    { path: '/tail', kind: 'tail' },
    { path: '/defectId', kind: 'defect' },
  ],
  async handler(input, ctx) {
    const denied = requireApproval(ctx);
    if (denied) return { ok: false, error: denied };
    const text = input.defectId ? `[${input.defectId}] ${input.text}` : input.text;
    return fromResult(addTechlogEntry(ctx.state, input.tail, text, !!approverOf(ctx), ctx.rng), (entry) => ({
      techlog: entry,
      aiDrafted: true,
    }));
  },
};
