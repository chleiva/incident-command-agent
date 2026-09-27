/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { END, Frame, MID, viewAt, S01 } from '../../stories/support';
import { RotationGantt } from './RotationGantt';

const meta: Meta<typeof RotationGantt> = {
  title: 'Zones/Network/RotationGantt',
  component: RotationGantt,
  decorators: [
    (Story) => (
      <Frame title="Rotation" width={760}>
        <Story />
      </Frame>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof RotationGantt>;

const pick = (v: typeof MID.view) => ({
  flights: Object.values(v.systems.occ.flights),
  aircraft: Object.values(v.systems.mne.aircraft),
  nowIso: v.simTime,
});

export const Empty: Story = { args: { flights: [] } };
export const Loading: Story = { args: { ...pick(MID.view), status: 'loading' } };
export const Live: Story = { name: 'Live (delay propagating, amber and red)', args: pick(MID.view) };
export const Early: Story = { name: 'Live (minute 3, first delay)', args: pick(viewAt(S01.agent, 3).view) };
export const SwapApproved: Story = { name: 'Live (swap approved, recedes)', args: pick(END.view) };
export const ErrorState: Story = {
  name: 'Error',
  args: { ...pick(MID.view), status: 'error', error: 'OCC unavailable' },
};
