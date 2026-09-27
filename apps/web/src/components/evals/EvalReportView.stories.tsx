/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { MOCK_EVAL_REPORT } from '../../mocks/evalReport';
import { EvalReportView } from './EvalReportView';

const meta: Meta<typeof EvalReportView> = {
  title: 'Pages/EvalReportView',
  component: EvalReportView,
  decorators: [
    (Story) => (
      <div className="max-w-[1280px]">
        <Story />
      </div>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof EvalReportView>;

export const Empty: Story = { args: { report: null } };
export const Loading: Story = { args: { report: null, status: 'loading' } };
export const Live: Story = { args: { report: MOCK_EVAL_REPORT } };
export const BudgetLow: Story = {
  name: 'Live (budget nearly spent)',
  args: {
    report: {
      ...MOCK_EVAL_REPORT,
      judgeScores: undefined,
      deltas: undefined,
      ledger: { lifetimeCapGbp: 10, spentGbp: 9.4, reservedGbp: 0, remainingGbp: 0.6 },
    },
  },
};
export const ErrorState: Story = {
  name: 'Error',
  args: { report: null, status: 'error', error: 'GET /evals/latest failed (404)' },
};
