/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { BASE_MARKERS, Frame, MARKERS, clock } from '../../stories/support';
import { TimeScrubber } from './TimeScrubber';

const meta: Meta<typeof TimeScrubber> = {
  title: 'Zones/Timeline/TimeScrubber',
  component: TimeScrubber,
  args: {
    onScrub: fn(),
    onJump: fn(),
    onLive: fn(),
    onPlayToggle: fn(),
    onSpeed: fn(),
    clock,
    speed: 6,
    playing: true,
  },
  decorators: [
    (Story) => (
      <Frame title="Timeline" width={760}>
        <Story />
      </Frame>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof TimeScrubber>;

export const Empty: Story = { args: { maxMinute: 0, cursorMinute: 0, live: true, markers: [] } };
export const Loading: Story = {
  args: { maxMinute: 0, cursorMinute: 0, live: true, markers: [], status: 'loading' },
};
export const Live: Story = {
  args: { maxMinute: 58.8, cursorMinute: 58.8, live: true, markers: MARKERS, baselineMarkers: BASE_MARKERS },
};
export const History: Story = {
  name: 'Live (scrubbed back in history)',
  args: {
    maxMinute: 58.8,
    cursorMinute: 21,
    live: false,
    playing: false,
    markers: MARKERS,
    baselineMarkers: BASE_MARKERS,
  },
};
export const ErrorState: Story = {
  name: 'Error',
  args: {
    maxMinute: 0,
    cursorMinute: 0,
    live: true,
    markers: [],
    status: 'error',
    error: 'Event log unavailable',
  },
};
