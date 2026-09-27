/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import type { AirborneFlight, CommanderLogEntry, ResourceRequest } from '@ica/schema/browser';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Frame } from '../../stories/support';
import { ArrivalPanel } from './ArrivalPanel';

const AIRBORNE: AirborneFlight = {
  flight: 'ACX131',
  tail: 'AX-TBR',
  phase: 'airborne',
  squawk: 'pan',
  from: 'MAN',
  plannedDestination: 'PMI',
  destination: 'MAN',
  lat: 53.0,
  lon: -2.2,
  positionAtMinute: 2,
  altitudeFt: 10000,
  headingDeg: 350,
  etaMinute: 24,
  fuelEnduranceMin: 220,
  pax: 163,
  commanderDecision: 'turnback',
  decisionAtMinute: 2,
  overweightLanding: true,
};
const LOG: CommanderLogEntry[] = [
  {
    id: 'CMD-1',
    atMinute: 2,
    flight: 'ACX131',
    decision: 'turnback',
    airport: 'MAN',
    overweightLanding: true,
    note: 'PAN, returning to Manchester, overweight landing expected.',
    decidedBy: 'Commander',
  },
];
const FIRE: ResourceRequest = {
  id: 'RR-1',
  kind: 'fire_service',
  station: 'MAN',
  status: 'confirmed',
  etaMinute: 9,
};

const meta: Meta<typeof ArrivalPanel> = {
  title: 'Zones/Ground/ArrivalPanel',
  component: ArrivalPanel,
  decorators: [
    (Story) => (
      <Frame title="Arrival station" width={560}>
        <Story />
      </Frame>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof ArrivalPanel>;

export const BeforeDecision: Story = {
  name: 'Before the commander decides',
  args: {
    airborne: {
      ...AIRBORNE,
      squawk: 'normal',
      destination: 'PMI',
      commanderDecision: undefined,
      etaMinute: 125,
    },
    commanderLog: [],
    resources: [],
    tasks: [],
    engineers: [],
    minute: 1,
  },
};
export const Inbound: Story = {
  name: 'Turning back, fire cover requested',
  args: { airborne: AIRBORNE, commanderLog: LOG, resources: [FIRE], tasks: [], engineers: [], minute: 12 },
};
export const Landed: Story = {
  name: 'Landed',
  args: {
    airborne: { ...AIRBORNE, phase: 'landed', landedAtMinute: 24 },
    commanderLog: LOG,
    resources: [FIRE],
    tasks: [],
    engineers: [],
    minute: 30,
  },
};
