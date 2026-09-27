/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import type { PassengerMessage, ToolDefinition } from '@ica/schema';
import { sendMessage } from '../systems/pss/index';
import { MESSAGE_BODY } from './draft_passenger_message';
import {
  REQUEST_ID_KEY,
  S,
  approverOf,
  arrayOf,
  byRequestId,
  fromResult,
  obj,
  replayed,
  requireApproval,
  tagRequest,
} from './_shared';

export const send_passenger_message: ToolDefinition<{
  requestId: string;
  messageId?: string;
  cohortIds?: string[];
  channel?: PassengerMessage['channel'];
  body?: string;
}> = {
  name: 'send_passenger_message',
  description:
    'Propose sending a passenger message: either an existing draft (messageId) or a new one (cohortIds + channel + body). A human approves before it goes out; once sent, the cohorts count as informed. Messages are labelled AI-drafted.',
  inputSchema: obj(
    {
      messageId: S.id,
      cohortIds: arrayOf(S.id, 12),
      channel: { type: 'string', enum: ['sms', 'email', 'app'] },
      body: MESSAGE_BODY,
      requestId: S.requestId,
    },
    ['requestId'],
  ),
  tier: 'propose',
  system: 'comms',
  roles: ['passenger'],
  mutates: true,
  idempotencyKey: REQUEST_ID_KEY,
  approvalScope: 'Sending this exact message, once, to the listed cohorts on the channel shown.',
  approvalExclusions: [
    'Any other message or a later update (each needs its own approval)',
    'Rebooking, care vouchers or compensation decisions',
  ],
  defaultUnresolvedChecks: ['The next-update time in the message is still achievable'],
  outputScreen: { kind: 'passenger_message', fields: ['/body'] },
  refs: [{ path: '/cohortIds', kind: 'cohort' }],
  async handler(input, ctx) {
    const denied = requireApproval(ctx);
    if (denied) return { ok: false, error: denied };
    const shape = (m: PassengerMessage) => ({
      messageId: m.id,
      status: m.status,
      sentAtMinute: m.sentAtMinute,
      cohortIds: m.cohortIds,
      aiDrafted: true as const,
    });
    // Idempotent: a repeat requestId returns the message already sent; passengers are not messaged twice.
    const [prior] = byRequestId(ctx.state.pss.messages, input.requestId);
    if (prior) return replayed(shape(prior));
    const { requestId, ...rest } = input;
    const r = sendMessage(ctx.state, rest, ctx.simMinute, approverOf(ctx), ctx.rng);
    return fromResult(
      r.ok
        ? {
            ...r,
            mutations: tagRequest(r.mutations, 'pss', 'messages', requestId, 'requestId', [
              'create',
              'update',
            ]),
          }
        : r,
      shape,
    );
  },
};
