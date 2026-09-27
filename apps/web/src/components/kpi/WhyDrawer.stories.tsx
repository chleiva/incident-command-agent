/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { EARLY, MID } from '../../stories/support';
import { WhyDrawer } from './WhyDrawer';

const meta: Meta<typeof WhyDrawer> = {
  title: 'Zones/KPI/WhyDrawer',
  component: WhyDrawer,
  args: { onClose: fn(), onJump: fn(), startTime: '2026-06-14T06:50:00Z' },
};
export default meta;
type Story = StoryObj<typeof WhyDrawer>;

export const Empty: Story = {
  name: 'Empty (nothing has moved it yet)',
  args: { tile: 'safety', kpis: EARLY.view.kpis, events: EARLY.events },
};
export const Loading: Story = {
  name: 'Loading (events not hydrated yet)',
  args: { tile: 'satisfaction', kpis: MID.view.kpis, events: [] },
};
export const Live: Story = { args: { tile: 'cost', kpis: MID.view.kpis, events: MID.events } };
export const ErrorState: Story = {
  name: 'Error (no snapshot: closed)',
  args: { tile: 'cost', kpis: null, events: [] },
};
