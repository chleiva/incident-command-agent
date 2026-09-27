/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { latestCaption } from '../../lib/narrator';
import { EARLY, fourStates } from '../../stories/support';
import { Narrator } from './Narrator';

const meta: Meta<typeof Narrator> = { title: 'Zones/Narrator', component: Narrator };
export default meta;
type Story = StoryObj<typeof Narrator>;

const s = fourStates(
  () => <Narrator caption={latestCaption(EARLY.events)} />,
  () => <Narrator caption={null} />,
  (n) => <div className="w-[900px]">{n}</div>,
);
export const Empty: Story = s.Empty;
export const Loading: Story = s.Loading;
export const Live: Story = s.Live;
export const ErrorState: Story = s.ErrorState;
