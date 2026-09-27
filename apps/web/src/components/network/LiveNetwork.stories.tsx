/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import { flightStateAt, generateDaySchedule, isAirborne, type DaySchedule } from '@ica/network';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useNetworkClock } from '../../lib/networkClock';
import { Frame } from '../../stories/support';
import { FlightList } from './FlightList';
import { FlightPanel } from './FlightPanel';
import { LiveNetworkMap } from './LiveNetworkMap';
import { NetworkClockBar } from './NetworkClockBar';
import { ReportIncidentDialog } from './ReportIncidentDialog';

const DATE = '2026-09-27';
const schedule = generateDaySchedule('accent-air', DATE);
const at = (hhmm: string) => Date.parse(`${DATE}T${hhmm}:00Z`);
const EMPTY: DaySchedule = { ...schedule, flights: [], tails: [], crews: [] };

/** Pin the network clock (stories and the a11y scan must be deterministic). */
function pin(t: number) {
  useNetworkClock.setState({ anchorT: t, anchorWall: Date.now(), speed: 0, live: false });
}

const meta: Meta = { title: 'Zones/Network/Live network' };
export default meta;
type Story = StoryObj;

export const MapLive: Story = {
  name: 'Map · live (12:00Z)',
  render: () => {
    pin(at('12:00'));
    return (
      <Frame title="Live network" width={1100} height={640}>
        <div className="relative h-[580px]">
          <LiveNetworkMap schedule={schedule} />
        </div>
      </Frame>
    );
  },
};

export const MapSelected: Story = {
  name: 'Map · selected airborne flight',
  render: () => {
    pin(at('12:00'));
    const f = schedule.flights.find((x) => isAirborne(flightStateAt(x, at('12:00')).phase))!;
    return (
      <Frame title="Live network" width={1100} height={640}>
        <div className="relative h-[580px]">
          <LiveNetworkMap schedule={schedule} selected={f.flight} />
        </div>
      </Frame>
    );
  },
};

export const MapNight: Story = {
  name: 'Map · night (everything on the ground)',
  render: () => {
    pin(at('23:50'));
    return (
      <Frame title="Live network" width={1100} height={640}>
        <div className="relative h-[580px]">
          <LiveNetworkMap schedule={schedule} />
        </div>
      </Frame>
    );
  },
};

export const ListLive: Story = {
  name: 'Flight list · live',
  render: () => (
    <div className="h-[640px] w-[360px]">
      <FlightList schedule={schedule} t={at('12:00')} onSelect={() => {}} />
    </div>
  ),
};

export const ListEmpty: Story = {
  name: 'Flight list · empty',
  render: () => (
    <div className="h-[320px] w-[360px]">
      <FlightList schedule={EMPTY} t={at('12:00')} onSelect={() => {}} />
    </div>
  ),
};

export const PanelAirborne: Story = {
  name: 'Flight panel · airborne',
  render: () => {
    const t = at('12:00');
    const f = schedule.flights.find((x) => isAirborne(flightStateAt(x, t).phase))!;
    return (
      <div className="h-[900px] w-[420px]">
        <FlightPanel schedule={schedule} flight={f} t={t} onClose={() => {}} onReport={() => {}} />
      </div>
    );
  },
};

export const PanelGround: Story = {
  name: 'Flight panel · boarding',
  render: () => {
    const t = at('12:00');
    const f = schedule.flights.find((x) => flightStateAt(x, t).phase === 'boarding') ?? schedule.flights[0]!;
    return (
      <div className="h-[720px] w-[420px]">
        <FlightPanel schedule={schedule} flight={f} t={t} onClose={() => {}} onReport={() => {}} />
      </div>
    );
  },
};

export const Clock: Story = {
  name: 'Clock bar',
  render: () => {
    pin(at('12:00'));
    return <NetworkClockBar t={at('12:00')} />;
  },
};

export const ReportDialog: Story = {
  name: 'Report incident · boarding flight',
  render: () => {
    const t = at('12:00');
    const f = schedule.flights.find((x) => flightStateAt(x, t).phase === 'boarding') ?? schedule.flights[0]!;
    return (
      <ReportIncidentDialog
        open
        onOpenChange={() => {}}
        schedule={schedule}
        flight={f}
        t={t}
        mode="mock"
        onStart={async () => null}
      />
    );
  },
};

export const ReportDialogAirborne: Story = {
  name: 'Report incident · airborne flight',
  render: () => {
    const t = at('12:00');
    const f = schedule.flights.find((x) => isAirborne(flightStateAt(x, t).phase))!;
    return (
      <ReportIncidentDialog
        open
        onOpenChange={() => {}}
        schedule={schedule}
        flight={f}
        t={t}
        onStart={async () => null}
      />
    );
  },
};
