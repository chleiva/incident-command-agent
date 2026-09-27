/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Frame, MID, fourStates } from '../../stories/support';
import { EntityTable } from './EntityTable';

const meta: Meta<typeof EntityTable> = { title: 'Zones/Inspector/EntityTable', component: EntityTable };
export default meta;
type Story = StoryObj<typeof EntityTable>;

const flights = Object.values(MID.view.systems.occ.flights) as unknown as Record<string, unknown>[];
const s = fourStates(
  () => (
    <EntityTable
      title="flights"
      rows={flights}
      keyField="flight"
      recent={new Map([['ACX214', 120]])}
      latestId="ACX215"
    />
  ),
  () => <EntityTable title="swaps" rows={[]} keyField="id" />,
  (n) => (
    <Frame title="OCC" width={760}>
      {n}
    </Frame>
  ),
);
export const Empty: Story = s.Empty;
export const Loading: Story = s.Loading;
export const Live: Story = s.Live;
export const ErrorState: Story = s.ErrorState;
