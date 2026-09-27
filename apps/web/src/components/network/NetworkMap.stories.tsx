/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { DEFAULT_STATIONS } from '../../lib/brand';
import { END, Frame, MID, S04, viewAt } from '../../stories/support';
import { NetworkMap } from './NetworkMap';

const meta: Meta<typeof NetworkMap> = {
  title: 'Zones/Network/NetworkMap',
  component: NetworkMap,
  decorators: [
    (Story) => (
      <Frame title="Network" width={760} height={420}>
        <div className="h-[360px]">
          <Story />
        </div>
      </Frame>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof NetworkMap>;

const pick = (v: typeof MID.view) => ({
  stations: DEFAULT_STATIONS,
  flights: Object.values(v.systems.occ.flights),
  aircraft: Object.values(v.systems.mne.aircraft),
  spares: Object.values(v.systems.occ.spares),
  engineers: Object.values(v.systems.engineers.engineers),
  focusTail: Object.values(v.systems.mne.aircraft)[0]?.tail,
});

export const Empty: Story = { args: { stations: [], flights: [], aircraft: [], spares: [], engineers: [] } };
export const Loading: Story = { args: { ...pick(MID.view), status: 'loading' } };
export const Live: Story = { name: 'Live (s01, AOG at MAN)', args: pick(MID.view) };
export const SwapApproved: Story = { name: 'Live (s01, swap approved)', args: pick(END.view) };
export const Outstation: Story = { name: 'Live (s04, FAO)', args: pick(viewAt(S04.agent, 15).view) };
export const ErrorState: Story = {
  name: 'Error',
  args: { ...pick(MID.view), status: 'error', error: 'Station list unavailable' },
};
