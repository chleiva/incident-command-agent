/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ProjectedApproval } from '@ica/schema/browser';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import type { DecideOutcome } from '../../app/actions';
import { pendingByUrgency } from '../../lib/derive';
import { S01, viewAt } from '../../stories/support';
import { DecisionPopup, resetDecisionPopupState } from './DecisionPopup';

const two = pendingByUrgency(viewAt(S01.agent, 38.5).view);
const first = two[0]!;
const third: ProjectedApproval = {
  ...first,
  approvalId: 'ap-story-3',
  createdAtMinute: first.createdAtMinute + 1,
  summary: 'Book hotel rooms for the 12 connecting passengers who will misconnect',
};
const QUEUE = [...two, third];

const meta: Meta<typeof DecisionPopup> = {
  title: 'Zones/Decisions/DecisionPopup',
  component: DecisionPopup,
  args: {
    pending: [first],
    nowMinute: 39,
    // The default for everyone: the card waits for the viewer (auto-approve is turned on in ⌘K).
    autoApprove: false,
    static: true,
    onDecide: fn(async (): Promise<DecideOutcome> => 'ok'),
  },
  decorators: [
    (Story) => {
      resetDecisionPopupState();
      return (
        // `transform` contains the popup's fixed positioning inside the canvas.
        <div className="relative h-[640px] w-full bg-bg" style={{ transform: 'translateZ(0)' }}>
          <p className="p-4 text-caption text-fg-muted">
            The page stays usable: the card floats bottom-right and never traps focus.
          </p>
          <Story />
        </div>
      );
    },
  ],
};
export default meta;
type Story = StoryObj<typeof DecisionPopup>;

export const Waiting: Story = {
  name: 'Waiting for the viewer (default: auto-approve off, Space hint)',
};
export const CountdownRunning: Story = {
  name: 'Countdown running (auto-approve turned on in ⌘K)',
  args: { autoApprove: true, initialRemainingMs: 7_000 },
};
export const Paused: Story = {
  name: 'Paused (hovered or focused, auto-approve on)',
  args: { autoApprove: true, initialRemainingMs: 6_000, forcePaused: true },
};
export const QueueOfThree: Story = {
  name: 'Queue of 3 (most urgent first)',
  args: { pending: QUEUE },
};
export const Editing: Story = {
  name: 'Editing (no auto-approval)',
  args: { initialMode: 'editing' },
};
export const Conflict: Story = {
  name: '409: decided elsewhere first (closes gracefully)',
  args: {
    pending: two,
    autoApprove: true,
    durationMs: 1_500,
    onDecide: fn(async (): Promise<DecideOutcome> => 'conflict'),
  },
};
export const AutoApproveOff: Story = {
  name: 'Auto-approve off (waits), queue of 3',
  args: { autoApprove: false, pending: QUEUE },
};
export const HistoryMode: Story = {
  name: 'Viewer in history mode (the card is live)',
  args: { historyMinute: 12 },
};
