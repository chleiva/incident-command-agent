/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ToolDefinition } from '@ica/schema';
import { estimateExposure } from '../systems/pss/index';
import { S, arrayOf, fromResult, obj } from './_shared';

export const estimate_eu261_exposure: ToolDefinition<{ cohortIds?: string[]; extraDelayMin?: number }> = {
  name: 'estimate_eu261_exposure',
  description:
    'Estimate EU261/UK261 compensation exposure per cohort from route distance (≤1500 km €250; >1500 km intra-EU or 1500–3500 km €400; otherwise €600), given the current projected delay (optionally plus extra minutes, for what-ifs). Compensation applies from a 3-hour arrival delay or on cancellation. Also returns minutes left before the 3-hour threshold. An estimate, not a legal determination.',
  inputSchema: obj({
    cohortIds: arrayOf(S.id, 12),
    extraDelayMin: { type: 'integer', minimum: 0, maximum: 1440 },
  }),
  tier: 'execute',
  system: 'pss',
  roles: ['passenger'],
  mutates: false,
  refs: [{ path: '/cohortIds', kind: 'cohort' }],
  handler: async (input, ctx) =>
    fromResult(
      estimateExposure(ctx.state, ctx.scenario, input.cohortIds, input.extraDelayMin ?? 0),
      (v) => v,
    ),
};
