/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import type { EngineeringDecision, ToolDefinition } from '@ica/schema';
import { recordEngineeringDecision } from '../systems/mne/index';
import { S, approverOf, fromResult, obj, requireApproval } from './_shared';

export const record_engineering_decision: ToolDefinition<{
  tail: string;
  decision: EngineeringDecision['decision'];
  rationale: string;
  defectId?: string;
  melItem?: string;
}> = {
  name: 'record_engineering_decision',
  description:
    'Propose that a human records an engineering decision (rectify, defer_mel, aog or release) with its rationale. The approving person becomes the decision-maker; defer_mel and release take effect only if they are certifying staff. Use it to capture the decision, never to take it yourself.',
  inputSchema: obj(
    {
      tail: S.tail,
      decision: { type: 'string', enum: ['rectify', 'defer_mel', 'aog', 'release'] },
      rationale: { type: 'string', minLength: 10, maxLength: 800 },
      defectId: S.id,
      melItem: S.melItem,
    },
    ['tail', 'decision', 'rationale'],
  ),
  tier: 'propose',
  system: 'mne',
  roles: ['maintenance'],
  mutates: true,
  approvalScope: 'Recording this engineering decision in the tech log as taken by you, the approver.',
  approvalExclusions: [
    'Anything a certifying engineer has not decided: deferral and release take effect only if you are certifying staff',
    'Departure (the commander decides)',
  ],
  defaultUnresolvedChecks: ['Inspection completed and signed by certifying staff'],
  outputScreen: { kind: 'report', fields: ['/rationale'] },
  refs: [
    { path: '/tail', kind: 'tail' },
    { path: '/defectId', kind: 'defect' },
  ],
  async handler(input, ctx) {
    const denied = requireApproval(ctx);
    if (denied) return { ok: false, error: denied };
    return fromResult(
      recordEngineeringDecision(ctx.state, input, approverOf(ctx), input.rationale, ctx.simMinute, ctx.rng),
      (d) => ({ decision: d }),
    );
  },
};
