/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactNode } from 'react';
import type { FeedItem, ToolFeedItem } from '../../lib/derive';
import { END, FEED_MID, Frame, fourStates } from '../../stories/support';
import { agentFeed } from '../../lib/derive';
import { FeedLine, ToolCallCard } from './ToolCallCard';

const meta: Meta<typeof ToolCallCard> = { title: 'Zones/Agents/ToolCallCard', component: ToolCallCard };
export default meta;
type Story = StoryObj<typeof ToolCallCard>;

const tools = FEED_MID.filter((f): f is ToolFeedItem => f.kind === 'tool');
const cited = tools.find((t) => (t.result?.citations?.length ?? 0) > 0)!;
const blocked = tools.find((t) => t.blocked)!;
const proposal = tools.find((t) => t.proposal && t.decision)!;
const report = agentFeed(END.events).find(
  (f): f is Extract<FeedItem, { kind: 'report' }> => f.kind === 'report',
)!;
const frame = (n: ReactNode) => (
  <Frame title="Agent activity" width={460}>
    <div className="flex flex-col gap-2">{n}</div>
  </Frame>
);
const s = fourStates(
  () => (
    <>
      <ToolCallCard item={cited} />
      <ToolCallCard item={proposal} />
      <ToolCallCard item={blocked} />
      <FeedLine item={report} />
    </>
  ),
  () => <p className="text-caption text-fg-subtle">No steps yet.</p>,
  frame,
);
export const Empty: Story = s.Empty;
export const Loading: Story = s.Loading;
export const Live: Story = { ...s.Live, name: 'Live (citations, decision, calm guardrail block, report)' };
export const ErrorState: Story = s.ErrorState;
export const Expanded: Story = {
  name: 'Live (expanded detail)',
  render: () => frame(<ToolCallCard item={cited} defaultOpen />),
};
