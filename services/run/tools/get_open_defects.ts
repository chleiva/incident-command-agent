/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ToolDefinition } from '@ica/schema';
import { defectView } from '../systems/mne/index';
import { S, obj, ok } from './_shared';

export const get_open_defects: ToolDefinition<{ tail?: string }> = {
  name: 'get_open_defects',
  description:
    'List open and deferred defects (optionally for one tail) with ATA chapter and any MEL item referenced. Deferred defects show who deferred them. Use it to see what still blocks dispatch.',
  inputSchema: obj({ tail: S.tail }),
  tier: 'execute',
  system: 'mne',
  roles: ['maintenance'],
  mutates: false,
  refs: [{ path: '/tail', kind: 'tail' }],
  async handler({ tail }, ctx) {
    const defects = Object.values(ctx.state.mne.defects)
      .filter((d) => d.status !== 'rectified' && (!tail || d.tail === tail))
      .map(defectView);
    return ok({ defects, count: defects.length });
  },
};
