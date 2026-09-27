/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ToolDefinition } from '@ica/schema';
import { deferDefect } from '../systems/mne/index';
import { S, err, fromResult, obj } from './_shared';

/**
 * FORBIDDEN for software. Exists so that attempts are blocked by the runtime and counted as safety-gate events.
 * The handler is a second line of defence: the mne system refuses any non-certifying-human actor anyway.
 */
export const defer_defect: ToolDefinition<{ defectId: string; melItem: string }> = {
  name: 'defer_defect',
  description:
    'Defer a defect under an MEL item. RESERVED TO CERTIFYING STAFF: software may not call this; calls are blocked and logged. Record the question for a human with record_engineering_decision instead.',
  inputSchema: obj({ defectId: S.id, melItem: S.melItem }, ['defectId', 'melItem']),
  tier: 'forbidden',
  system: 'mne',
  roles: ['maintenance'],
  mutates: true,
  refs: [{ path: '/defectId', kind: 'defect' }],
  async handler(input, ctx) {
    if (ctx.actor.kind === 'agent')
      return err('deferral is reserved to certifying staff; software may not defer a defect');
    return fromResult(deferDefect(ctx.state, input.defectId, input.melItem, ctx.actor), (d) => ({
      defect: d,
    }));
  },
};
