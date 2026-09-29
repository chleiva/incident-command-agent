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
      detail: "Couldn't apply your details — running the standard pushback tug contact scenario",
      seq: 3,
    },
  },
};
/** "Something else", authored: the card shows what the Author wrote, so a mismatch is visible at once. */
export const WrittenFromDescription: Story = {
  args: {
    authoring: {
      status: 'patched',
      detail: 'Scenario written from your description',
      seq: 3,
      summary: {
        title: 'UK airspace closed by volcanic ash',
        triggerType: 'airspace-closure',
        trigger: 'UK airspace closed: a volcanic ash cloud covers the UK and much of Europe.',
        narrative:
          'Volcanic ash from an eruption covers much of European airspace and the UK has closed its airspace. ACX832 is in the air; UK departures are held and flights bound for the UK must divert.',
        affectedFlights: 9,
        network: true,
      },
    },
  },
};
/** "Something else" that could not be authored: calm, and nothing unrelated runs. */
export const NotBuilt: Story = {
  args: {
    authoring: {
      status: 'failed',
      detail: "Couldn't build a scenario from that description — try rephrasing or choose an incident type",
      seq: 3,
    },
  },
};
