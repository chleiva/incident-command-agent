/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { activeRoles, agentFeed } from '../../lib/derive';
import { END, FEED_MID, ROLES_MID } from '../../stories/support';
import { AgentStream } from './AgentStream';

const meta: Meta<typeof AgentStream> = {
  title: 'Zones/Agents/AgentStream',
  component: AgentStream,
  decorators: [
    (Story) => (
      <div
        style={{ width: 460, height: 640 }}
        className="flex flex-col rounded-lg border border-border bg-surface"
      >
        <Story />
      </div>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof AgentStream>;

export const Empty: Story = { args: { items: [], roleStates: new Map() } };
export const Loading: Story = { args: { items: [], roleStates: new Map(), status: 'loading' } };
export const Live: Story = {
  name: 'Live (agents working, one awaiting a decision)',
  args: { items: FEED_MID, roleStates: ROLES_MID },
};
export const Ended: Story = {
  name: 'Live (all reported)',
  args: { items: agentFeed(END.events), roleStates: activeRoles(END.view) },
};
export const ErrorState: Story = {
  name: 'Error',
  args: { items: [], roleStates: new Map(), status: 'error', error: 'Stream unavailable' },
};
