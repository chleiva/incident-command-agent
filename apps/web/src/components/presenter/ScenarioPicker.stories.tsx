/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { summariseScenario, SHIPPED_SCENARIOS, type ScenarioSummary } from '@ica/schema/browser';
import { fn } from 'storybook/test';
import { S01, S04 } from '../../stories/support';
import { ScenarioPicker } from './ScenarioPicker';

const meta: Meta<typeof ScenarioPicker> = {
  title: 'Presenter/ScenarioPicker',
  component: ScenarioPicker,
  args: { onStart: fn() },
  decorators: [
    (Story) => (
      <div className="max-w-[1200px]">
        <Story />
      </div>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof ScenarioPicker>;

const recorded = [summariseScenario(S01.scenario), summariseScenario(S04.scenario)];
const all: ScenarioSummary[] = [
  ...recorded,
  ...SHIPPED_SCENARIOS.filter((s) => !recorded.some((r) => r.id === s.id)).map((s) => ({
    id: s.id,
    title: s.title,
    station: s.station,
    aircraftType: 'A320',
    triggerType: s.outstation ? 'outstation incident' : 'home-base incident',
    visibility: 'public' as const,
    twistCount: 2,
    inspiredBy: [],
  })),
].sort((a, b) => a.id.localeCompare(b.id));

export const Empty: Story = { args: { scenarios: [] } };
export const Loading: Story = { args: { scenarios: [], status: 'loading' } };
export const Live: Story = {
  args: {
    scenarios: all,
    unavailableReason: (id: string) =>
      recorded.some((r) => r.id === id) ? null : 'Mock mode: needs the local dev server',
  },
};
export const ErrorState: Story = {
  name: 'Error',
  args: { scenarios: [], status: 'error', error: 'GET /scenarios failed (502)' },
};
