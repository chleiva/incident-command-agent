/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Meta, StoryObj } from '@storybook/react-vite';
import type { RunMeta } from '@ica/schema/browser';
import { MemoryRouter } from 'react-router-dom';
import { MOCK_EVAL_REPORT } from '../../mocks/evalReport';
import { EvalSummary, RecentRuns } from './HomePanels';

const meta: Meta<typeof RecentRuns> = {
  title: 'Pages/Home/RecentRuns + EvalSummary',
  component: RecentRuns,
  decorators: [
    (Story) => (
      <MemoryRouter>
        <div className="flex w-[640px] flex-col gap-4">
          <Story />
        </div>
      </MemoryRouter>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof RecentRuns>;

const run = (i: number, over: Partial<RunMeta> = {}): RunMeta => ({
  runId: `run-demo-${i}`,
  scenarioId: 's01-pushback-tug-contact',
  scenarioTitle: 'Towbar shear and nose-gear contact on pushback',
  mode: 'agent',
  status: 'completed',
  pairedRunId: `run-demo-${i}-baseline`,
  createdAt: '2026-06-14T09:00:00Z',
  simMinute: 58.8,
  lastSeq: 324,
  totals: { inputTokens: 0, outputTokens: 0, costUsd: 0, toolCalls: 0, iterations: 0, wallMs: 0 },
  speed: 6,
  ...over,
});

export const Empty: Story = {
  render: () => (
    <>
      <RecentRuns runs={[]} status="ready" />
      <EvalSummary report={null} status="ready" />
    </>
  ),
};
export const Loading: Story = {
  render: () => (
    <>
      <RecentRuns runs={[]} status="loading" />
      <EvalSummary report={null} status="loading" />
    </>
  ),
};
export const Live: Story = {
  render: () => (
    <>
      <RecentRuns
        runs={[
          run(1),
          run(2, {
            status: 'running',
            simMinute: 21,
            scenarioTitle: 'Lightning strike at outstation, no licensed engineer on site',
          }),
          run(3, { status: 'failed', pairedRunId: undefined }),
        ]}
        status="ready"
      />
      <EvalSummary report={MOCK_EVAL_REPORT} status="ready" />
    </>
  ),
};
export const ErrorState: Story = {
  name: 'Error',
  render: () => (
    <>
      <RecentRuns runs={[]} status="error" error="GET /runs failed" />
      <EvalSummary report={null} status="error" error="GET /evals/latest failed" />
    </>
  ),
};
