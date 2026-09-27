/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import type { PassengerMessage, ToolDefinition } from '@ica/schema';
import { draftMessage } from '../systems/pss/index';
import { S, arrayOf, fromResult, obj } from './_shared';

export const MESSAGE_BODY = {
  type: 'string',
  minLength: 20,
  // Channel-appropriate cap (an SMS may be sent in parts); at least 1,000 since live run 2.
  maxLength: 1000,
  description:
    'Plain-language message: what happened (no blame), what we are doing, the specific next step for the passenger, and when the next update will come. No legal conclusions.',
} as const;

export const draft_passenger_message: ToolDefinition<{
  cohortIds: string[];
  channel: PassengerMessage['channel'];
  body: string;
}> = {
  name: 'draft_passenger_message',
  description:
    'Store a draft passenger message for one or more cohorts (checked by the output screen; marked AI-drafted). Drafting is free; sending needs send_passenger_message and a human approval. Returns the draft id.',
  inputSchema: obj(
    {
      cohortIds: arrayOf(S.id, 12),
      channel: { type: 'string', enum: ['sms', 'email', 'app'] },
      body: MESSAGE_BODY,
    },
    ['cohortIds', 'channel', 'body'],
  ),
  tier: 'execute',
  system: 'comms',
  roles: ['passenger'],
  mutates: true,
  outputScreen: { kind: 'passenger_message', fields: ['/body'] },
  refs: [{ path: '/cohortIds', kind: 'cohort' }],
  handler: async (input, ctx) =>
    fromResult(draftMessage(ctx.state, input, ctx.rng), (m) => ({
      messageId: m.id,
      status: m.status,
      aiDrafted: true,
    })),
};
