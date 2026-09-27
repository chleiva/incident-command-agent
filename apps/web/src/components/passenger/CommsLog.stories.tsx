/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { END, Frame, clock, pendingApproval, S01 } from '../../stories/support';
import { CommsLog } from './CommsLog';

const meta: Meta<typeof CommsLog> = {
  title: 'Zones/Passengers/CommsLog',
  component: CommsLog,
  args: { clock, onSelect: fn() },
  decorators: [
    (Story) => (
      <Frame title="Communications log" width={420}>
        <Story />
      </Frame>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof CommsLog>;

const pending = pendingApproval(S01.agent, 'ap-msg-2').view;
export const Empty: Story = { args: { messages: [] } };
export const Loading: Story = { args: { messages: [], status: 'loading' } };
export const Live: Story = {
  name: 'Live (sent + awaiting approval)',
  args: { messages: Object.values(pending.systems.pss.messages), cohortSize: () => 174 },
};
export const Ended: Story = {
  name: 'Live (all sent)',
  args: { messages: Object.values(END.view.systems.pss.messages), selectedId: 'msg-2' },
};
export const ErrorState: Story = {
  name: 'Error',
  args: { messages: [], status: 'error', error: 'PSS unavailable' },
};
