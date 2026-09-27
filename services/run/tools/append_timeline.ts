/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ToolDefinition } from '@ica/schema';
import { appendTimeline } from '../systems/record/index';
import { fromResult, obj } from './_shared';

export const TIMELINE_SOURCES = [
  'orchestrator',
  'maintenance',
  'ground',
  'flightops',
  'passenger',
  'record',
  'world',
  'human',
] as const;

export const append_timeline: ToolDefinition<{
  text: string;
  atMinute?: number;
  source?: (typeof TIMELINE_SOURCES)[number];
}> = {
  name: 'append_timeline',
  description:
    'Add a factual, time-stamped entry to the incident timeline (what happened, who decided what, when). Default time is now. Keep entries short and neutral; no speculation or blame.',
  inputSchema: obj(
    {
      text: { type: 'string', minLength: 5, maxLength: 400 },
      atMinute: { type: 'number', minimum: 0, maximum: 1440 },
      source: { type: 'string', enum: [...TIMELINE_SOURCES] },
    },
    ['text'],
  ),
  tier: 'execute',
  system: 'record',
  roles: ['record'],
  mutates: true,
  outputScreen: { kind: 'report', fields: ['/text'] },
  handler: async (input, ctx) =>
    fromResult(
      appendTimeline(
        ctx.state,
        { text: input.text, atMinute: input.atMinute ?? ctx.simMinute, source: input.source ?? 'record' },
        ctx.rng,
      ),
      (e) => ({ entry: e }),
    ),
};
