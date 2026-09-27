/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactNode } from 'react';
import { fn } from 'storybook/test';
import { END, Frame, S01, S04, fourStates, pendingApproval } from '../../stories/support';
import { DecisionCard } from './DecisionCard';

const meta: Meta<typeof DecisionCard> = { title: 'Zones/Decisions/DecisionCard', component: DecisionCard };
export default meta;
type Story = StoryObj<typeof DecisionCard>;

const msg = pendingApproval(S01.agent, 'ap-msg-1');
const eng = pendingApproval(S01.agent, 'ap-eng-1');
const opts = pendingApproval(S04.agent, 'ap4-decision-1');
const frame = (n: ReactNode) => (
  <Frame title="Decision needed" width={460}>
    {n}
  </Frame>
);

const s = fourStates(
  () => <DecisionCard approval={msg.approval} nowMinute={6} onDecide={fn()} />,
  () => <DecisionCard approval={END.view.approvals['ap-msg-1']!} nowMinute={58} onDecide={fn()} />,
  frame,
);
export const Empty: Story = { ...s.Empty, name: 'Empty (decided: shows the approver)' };
export const Loading: Story = s.Loading;
export const Live: Story = { ...s.Live, name: 'Live (passenger message, AI-drafted)' };
export const ErrorState: Story = {
  name: 'Error (POST failed, rolled back)',
  render: () =>
    frame(
      <DecisionCard
        approval={msg.approval}
        nowMinute={14}
        optimistic={{ decision: 'approve', state: 'error' }}
        onDecide={fn()}
      />,
    ),
};
export const Options: Story = {
  name: 'Live (options case, s04)',
  render: () => frame(<DecisionCard approval={opts.approval} nowMinute={15} onDecide={fn()} />),
};
export const Certifying: Story = {
  name: 'Live (certifying engineer decision)',
  render: () => frame(<DecisionCard approval={eng.approval} nowMinute={45} onDecide={fn()} />),
};
