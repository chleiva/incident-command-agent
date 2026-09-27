/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { END, Frame, MID, viewAt, S01 } from '../../stories/support';
import { CohortBoard } from './CohortBoard';

const meta: Meta<typeof CohortBoard> = {
  title: 'Zones/Passengers/CohortBoard',
  component: CohortBoard,
  decorators: [
    (Story) => (
      <Frame title="Passengers" width={560}>
        <Story />
      </Frame>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof CohortBoard>;

const early = viewAt(S01.agent, 4).view;
export const Empty: Story = { args: { cohorts: [], nowMinute: 0 } };
export const Loading: Story = { args: { cohorts: [], nowMinute: 0, status: 'loading' } };
export const Live: Story = {
  name: 'Live (informed)',
  args: { cohorts: Object.values(MID.view.systems.pss.cohorts), nowMinute: 31, triggerMinute: 2 },
};
export const Uninformed: Story = {
  name: 'Live (uninformed past 15 min: threshold)',
  args: { cohorts: Object.values(early.systems.pss.cohorts), nowMinute: 20, triggerMinute: 2 },
};
export const CareIssued: Story = {
  name: 'Live (care issued)',
  args: { cohorts: Object.values(END.view.systems.pss.cohorts), nowMinute: 58, triggerMinute: 2 },
};
export const ErrorState: Story = {
  name: 'Error',
  args: { cohorts: [], nowMinute: 0, status: 'error', error: 'PSS unavailable' },
};
