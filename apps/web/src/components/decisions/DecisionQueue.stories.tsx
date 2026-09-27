/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { decidedApprovals, pendingByUrgency } from '../../lib/derive';
import { END, Frame, viewAt, S01 } from '../../stories/support';
import { DecisionQueue } from './DecisionQueue';

const meta: Meta<typeof DecisionQueue> = {
  title: 'Zones/Decisions/DecisionQueue',
  component: DecisionQueue,
  args: { onDecide: fn(), announce: false },
  decorators: [
    (Story) => (
      <Frame title="Decision needed" width={460}>
        <Story />
      </Frame>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof DecisionQueue>;

const two = viewAt(S01.agent, 38.5).view;

export const Empty: Story = { args: { pending: [], decided: decidedApprovals(END.view), nowMinute: 58 } };
export const Loading: Story = { args: { pending: [], decided: [], nowMinute: 0, status: 'loading' } };
export const Live: Story = {
  name: 'Live (two pending, most urgent first)',
  args: { pending: pendingByUrgency(two), decided: decidedApprovals(two), nowMinute: 39 },
};
export const Sending: Story = {
  name: 'Live (optimistic: sending…)',
  args: {
    pending: pendingByUrgency(two),
    decided: [],
    nowMinute: 39,
    optimistic: { 'ap-msg-2': { decision: 'approve', state: 'sending' } },
  },
};
export const ErrorState: Story = {
  name: 'Error',
  args: { pending: [], decided: [], nowMinute: 0, status: 'error', error: 'Approvals could not be loaded.' },
};
