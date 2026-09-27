/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { END, GHOST_MID, MID, SERIES_MID } from '../../stories/support';
import { KpiStrip } from './KpiStrip';

const meta: Meta<typeof KpiStrip> = {
  title: 'Zones/KPI/KpiStrip',
  component: KpiStrip,
  args: { onOpen: fn() },
};
export default meta;
type Story = StoryObj<typeof KpiStrip>;

export const Empty: Story = { args: { kpis: null, series: [] } };
export const Loading: Story = { args: { kpis: null, series: [], status: 'loading' } };
export const Live: Story = { args: { kpis: MID.view.kpis, series: SERIES_MID, baseline: GHOST_MID } };
export const ErrorState: Story = {
  name: 'Error',
  args: { kpis: null, series: [], status: 'error', error: 'GET /runs/{id}/events failed (503)' },
};
export const DenseEnded: Story = {
  name: 'Dense (baseline row)',
  args: { kpis: END.view.kpis, series: [], dense: true },
};
