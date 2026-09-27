/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { emptySystemState } from '@ica/schema/browser';
import { Frame, MID, RECENT_MID } from '../../stories/support';
import { SystemTabs } from './SystemTabs';

const meta: Meta<typeof SystemTabs> = {
  title: 'Zones/Inspector/SystemTabs',
  component: SystemTabs,
  decorators: [
    (Story) => (
      <Frame title="System inspector" width={760} height={420}>
        <div className="flex h-[340px] flex-col">
          <Story />
        </div>
      </Frame>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof SystemTabs>;

export const Empty: Story = { args: { systems: emptySystemState(), recent: new Map(), lastMutation: null } };
export const Loading: Story = {
  args: { systems: emptySystemState(), recent: new Map(), lastMutation: null, status: 'loading' },
};
export const Live: Story = {
  name: 'Live (change highlight on the latest mutations)',
  args: {
    systems: MID.view.systems,
    recent: RECENT_MID,
    lastMutation: MID.view.lastMutation,
    defaultSystem: 'occ',
  },
};
export const ErrorState: Story = {
  name: 'Error',
  args: {
    systems: emptySystemState(),
    recent: new Map(),
    lastMutation: null,
    status: 'error',
    error: 'GET /runs/{id}/systems failed',
  },
};
