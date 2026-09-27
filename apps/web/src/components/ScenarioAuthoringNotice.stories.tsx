/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { ScenarioAuthoringNotice } from './ScenarioAuthoringNotice';

const meta: Meta<typeof ScenarioAuthoringNotice> = {
  title: 'Cockpit/ScenarioAuthoringNotice',
  component: ScenarioAuthoringNotice,
  args: { onDismiss: fn() },
  decorators: [
    (Story) => (
      <div className="w-[960px]">
        <Story />
      </div>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof ScenarioAuthoringNotice>;

export const Preparing: Story = {
  args: { authoring: { status: 'started', detail: 'Preparing scenario from your description…', seq: 2 } },
};
export const Enriched: Story = {
  args: { authoring: { status: 'patched', detail: 'Scenario enriched from your description', seq: 3 } },
};
export const Fallback: Story = {
  args: {
    authoring: {
      status: 'fallback',
      detail: 'Author unavailable — running the standard pushback tug contact scenario',
      seq: 3,
    },
  },
};
