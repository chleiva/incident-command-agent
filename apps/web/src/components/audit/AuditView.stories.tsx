/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { MemoryRouter } from 'react-router-dom';
import { AUDIT_META, AUDIT_RUN, FIRST_LLM, FIRST_TOOL, PROPOSED_TOOL, fixtureLoadTrace } from './storyData';
import { AuditView } from './AuditView';
import { RecentRunsTable, RunSelect } from './RunPicker';

const meta: Meta<typeof AuditView> = {
  title: 'Pages/AuditView',
  component: AuditView,
  args: { loadTrace: fixtureLoadTrace, virtualize: false },
  decorators: [
    (Story) => (
      <div className="flex h-[900px] max-w-[1600px] flex-col p-3">
        <Story />
      </div>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof AuditView>;

const picker = <RunSelect runs={[AUDIT_META]} value={AUDIT_META.runId} onChange={() => {}} />;

export const Empty: Story = { args: { run: { ...AUDIT_RUN, entries: [] }, status: 'ready', picker } };
export const Loading: Story = { args: { run: null, status: 'loading', picker } };
export const Live: Story = { args: { run: AUDIT_RUN, status: 'ready', picker, onExport: () => {} } };
export const Exporting: Story = {
  args: {
    run: AUDIT_RUN,
    status: 'ready',
    picker,
    onExport: () => {},
    exportProgress: { done: 7, total: AUDIT_RUN.entries.length },
  },
};
export const ErrorState: Story = {
  name: 'Error',
  args: { run: null, status: 'error', error: 'GET /runs/run-demo-s01/audit failed (503)', picker },
};
export const ExpandedLlmCall: Story = {
  name: 'Expanded LLM call',
  args: { run: AUDIT_RUN, status: 'ready', picker, initialExpanded: [FIRST_LLM.id] },
};
export const ExpandedToolCall: Story = {
  name: 'Expanded tool call',
  args: { run: AUDIT_RUN, status: 'ready', picker, initialExpanded: [FIRST_TOOL.id, PROPOSED_TOOL.id] },
};

export const RunList: StoryObj<typeof RecentRunsTable> = {
  name: 'Run picker (no run selected)',
  render: () => (
    <MemoryRouter>
      <RecentRunsTable
        runs={[AUDIT_META, { ...AUDIT_META, runId: 'run-demo-s01-b', mode: 'baseline' }]}
        status="ready"
      />
    </MemoryRouter>
  ),
};
