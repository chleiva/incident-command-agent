/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { RowStory } from './storyData';

const meta: Meta<typeof RowStory> = {
  title: 'Agents view/Row',
  component: RowStory,
};
export default meta;
type Story = StoryObj<typeof RowStory>;

export const Brief: Story = { args: { kind: 'brief' } };
export const BriefExpanded: Story = { args: { kind: 'brief', expanded: true } };
export const Thought: Story = { args: { kind: 'thought' } };
export const ThoughtExpanded: Story = { args: { kind: 'thought', expanded: true } };
export const ToolCall: Story = { args: { kind: 'tool' } };
export const ToolCallExpanded: Story = { args: { kind: 'tool', expanded: true } };
export const Proposal: Story = { args: { kind: 'proposal' } };
export const ProposalExpanded: Story = { args: { kind: 'proposal', expanded: true } };
export const WaitingLive: Story = { name: 'Waiting (live)', args: { kind: 'waiting' } };
export const WaitingExpanded: Story = {
  name: 'Waiting (live) expanded',
  args: { kind: 'waiting', expanded: true },
};
export const Decision: Story = { name: 'Decision (rejected)', args: { kind: 'decision' } };
export const DecisionExpanded: Story = {
  name: 'Decision expanded',
  args: { kind: 'decision', expanded: true },
};
export const Invalidated: Story = { name: 'Approval withdrawn', args: { kind: 'invalidated' } };
export const InvalidatedExpanded: Story = {
  name: 'Approval withdrawn expanded',
  args: { kind: 'invalidated', expanded: true },
};
export const Blocked: Story = { args: { kind: 'blocked' } };
export const BlockedExpanded: Story = { args: { kind: 'blocked', expanded: true } };
export const Stopped: Story = { args: { kind: 'stopped' } };
export const StoppedExpanded: Story = { args: { kind: 'stopped', expanded: true } };
export const StoppedHandover: Story = {
  name: 'Stopped for the hand-over to a fresh worker (calm)',
  args: { kind: 'stopped', handover: true, expanded: true },
};
export const Continuation: Story = {
  name: 'Continued in a fresh worker (divider)',
  args: { kind: 'continuation' },
};
export const ContinuationExpanded: Story = {
  name: 'Continued in a fresh worker expanded',
  args: { kind: 'continuation', expanded: true },
};
export const Report: Story = { name: 'Report (with screening flag)', args: { kind: 'report' } };
export const ReportExpanded: Story = { name: 'Report expanded', args: { kind: 'report', expanded: true } };
