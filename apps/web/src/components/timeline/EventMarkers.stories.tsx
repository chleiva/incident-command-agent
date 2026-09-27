/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { BASE_MARKERS, MARKERS, fourStates } from '../../stories/support';
import { EventMarkers, MARKER_LEGEND, MarkerGlyph } from './EventMarkers';

const meta: Meta<typeof EventMarkers> = { title: 'Zones/Timeline/EventMarkers', component: EventMarkers };
export default meta;
type Story = StoryObj<typeof EventMarkers>;

const track = (markers: typeof MARKERS, lane: 'agent' | 'baseline' = 'agent') => (
  <div className="relative h-7 w-full rounded-md bg-surface-sunken">
    <EventMarkers markers={markers} maxMinute={85} onJump={fn()} lane={lane} />
  </div>
);
const s = fourStates(
  () => (
    <div className="flex flex-col gap-2">
      {track(MARKERS)}
      {track(BASE_MARKERS, 'baseline')}
      <div className="flex gap-3 text-micro text-fg-subtle">
        {MARKER_LEGEND.map(([k, l]) => (
          <span key={k} className="inline-flex items-center gap-1">
            <MarkerGlyph kind={k} /> {l}
          </span>
        ))}
      </div>
    </div>
  ),
  () => track([]),
  (n) => <div className="w-[720px]">{n}</div>,
);
export const Empty: Story = s.Empty;
export const Loading: Story = s.Loading;
export const Live: Story = s.Live;
export const ErrorState: Story = s.ErrorState;
