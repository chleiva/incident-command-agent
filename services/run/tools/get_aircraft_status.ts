/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ToolDefinition } from '@ica/schema';
import { defectView, maintenanceView } from '../systems/mne/index';
import { S, err, obj, ok } from './_shared';

export const get_aircraft_status: ToolDefinition<{ tail: string }> = {
  name: 'get_aircraft_status',
  description:
    'Read the M&E record of one aircraft: status (serviceable/unserviceable/aog/released), station and stand, its maintenance record (last check, defect history; "Unknown" when not recorded), its defects, work orders with progress, and engineering decisions taken so far. Use it first when an aircraft is involved.',
  inputSchema: obj({ tail: S.tail }, ['tail']),
  tier: 'execute',
  system: 'mne',
  roles: ['maintenance'],
  mutates: false,
  refs: [{ path: '/tail', kind: 'tail' }],
  async handler({ tail }, ctx) {
    const ac = ctx.state.mne.aircraft[tail];
    if (!ac) return err(`unknown tail ${tail}`);
    const { maintenance: _record, ...aircraft } = ac;
    return ok({
      aircraft,
      maintenanceRecord: maintenanceView(ac),
      defects: Object.values(ctx.state.mne.defects)
        .filter((d) => d.tail === tail)
        .map(defectView),
      workOrders: Object.values(ctx.state.mne.workOrders).filter((w) => w.tail === tail),
      decisions: Object.values(ctx.state.mne.decisions).filter((d) => d.tail === tail),
      simMinute: ctx.simMinute,
    });
  },
};
