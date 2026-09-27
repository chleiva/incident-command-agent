/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { plainFailureReason } from '../lib/runHealth';
import { RunFailedBanner, RunRecoveryBanner } from './RunHealthBanner';

const meta: Meta<typeof RunFailedBanner> = {
  title: 'Cockpit/RunHealthBanner',
  component: RunFailedBanner,
  decorators: [
    (Story) => (
      <div className="w-[960px]">
        <Story />
      </div>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof RunFailedBanner>;

const error = 'anthropic 529 overloaded_error after 3 retries';
const failure = { error, where: 'llm', plain: plainFailureReason(error, 'llm'), minute: 31, seq: 210 };

export const Failed: Story = {
  name: 'Failed (cockpit): plain reason, technical details, Start again',
  args: { failure, onRestart: fn() },
};
export const FailedCompact: Story = {
  name: 'Failed (Agents view header notice)',
  args: { failure, onRestart: fn(), compact: true },
};
export const Recovering: StoryObj<typeof RunRecoveryBanner> = {
  name: 'Recovering from a system error',
  render: () => (
    <RunRecoveryBanner
      recovery={{
        status: 'recovering',
        attempt: 1,
        reason: 'Lambda timeout: 14 min wall clock',
        plain: plainFailureReason('Lambda timeout: 14 min wall clock'),
        seq: 120,
        resumedMinute: null,
      }}
    />
  ),
};
export const Recovered: StoryObj<typeof RunRecoveryBanner> = {
  name: 'Recovered (dismissible)',
  render: () => (
    <RunRecoveryBanner
      onDismiss={fn()}
      recovery={{
        status: 'recovered',
        attempt: 1,
        reason: 'Lambda timeout: 14 min wall clock',
        plain: plainFailureReason('Lambda timeout: 14 min wall clock'),
        seq: 124,
        resumedMinute: 19,
      }}
    />
  ),
};
