/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { decidedApprovals } from '../lib/derive';
import { BASE_END, END } from '../stories/support';
import { RunEndedCard } from './RunEndedCard';

const meta: Meta<typeof RunEndedCard> = {
  title: 'Cockpit/RunEndedCard',
  component: RunEndedCard,
  args: { onExportPdf: fn(), onExportJson: fn(), onDismiss: fn() },
};
export default meta;
type Story = StoryObj<typeof RunEndedCard>;

export const Empty: Story = {
  name: 'Empty (no baseline, no decisions)',
  args: { view: { ...END.view, approvals: {} }, baseline: null, decisions: [] },
};
export const Loading: Story = {
  name: 'Loading (rendering the PDF)',
  args: { view: END.view, baseline: BASE_END.kpis, decisions: decidedApprovals(END.view), exporting: 'pdf' },
};
export const Live: Story = {
  args: { view: END.view, baseline: BASE_END.kpis, decisions: decidedApprovals(END.view) },
};
export const ErrorState: Story = {
  name: 'Error (run failed)',
  args: {
    view: {
      ...END.view,
      meta: {
        ...END.view.meta,
        status: 'failed',
        error: { error: 'LLM provider unavailable after fallback', where: 'runtime' },
      },
    },
    baseline: null,
    decisions: decidedApprovals(END.view).slice(0, 2),
  },
};
