/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Meta, StoryObj } from '@storybook/react-vite';
import type { RunProjection } from '@ica/schema/browser';
import { engineerProgress, travelStarts } from '../../lib/derive';
import { END, Frame, S01, viewAt } from '../../stories/support';
import { StandView, type StandViewProps } from './StandView';

const meta: Meta<typeof StandView> = {
  title: 'Zones/Ground/StandView',
  component: StandView,
  decorators: [
    (Story) => (
      <Frame title="Ground" width={620} height={440}>
        <div className="h-[380px]">
          <Story />
        </div>
      </Frame>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof StandView>;

function props(minute: number, view?: RunProjection): StandViewProps {
  const at = view ? { view, events: S01.agent } : viewAt(S01.agent, minute);
  const v = at.view;
  const aircraft = Object.values(v.systems.mne.aircraft)[0] ?? null;
  const engineers = Object.values(v.systems.engineers.engineers);
  const eng =
    engineers.find((e) => e.status === 'on_site') ?? engineers.find((e) => e.status === 'travelling');
  const spare = Object.values(v.systems.occ.spares).find((s) => s.station === 'MAN');
  const starts = travelStarts(at.events);
  return {
    aircraft,
    stand: aircraft?.stand ? v.systems.airport.stands[aircraft.stand] : undefined,
    adjacent: { stand: v.systems.airport.stands['34']!, tail: spare?.tail, assigned: !!spare?.assignedTo },
    engineer: eng
      ? {
          engineer: eng,
          progress: engineerProgress(eng, starts[eng.id], minute),
          etaMin: eng.etaMinute !== undefined ? eng.etaMinute - minute : null,
        }
      : null,
    resources: Object.values(v.systems.airport.resourceRequests),
    weather: v.systems.airport.weather.MAN?.summary,
  };
}

export const Empty: Story = { args: { aircraft: null, resources: [] } };
export const Loading: Story = { args: { ...props(8), status: 'loading' } };
export const Live: Story = { name: 'Live (engineer on the way)', args: props(8) };
export const StairsAndBus: Story = { name: 'Live (stairs and buses confirmed)', args: props(27) };
export const Ended: Story = { name: 'Live (spare assigned)', args: props(58, END.view) };
export const ErrorState: Story = {
  name: 'Error',
  args: { ...props(8), status: 'error', error: 'Airport system unavailable' },
};
