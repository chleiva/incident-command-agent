/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { deriveAgents } from '../../agents/rows';
import { RECORDINGS } from '../../mocks/recordings';
import { AgentsBoard } from './AgentsBoard';
import { boardArgs, SHOWCASE_EVENTS, untilProposal } from './storyData';

const meta: Meta<typeof AgentsBoard> = {
  title: 'Agents view/Board',
  component: AgentsBoard,
  decorators: [
    (Story) => (
      <div style={{ height: 820 }} className="flex flex-col">
        <Story />
      </div>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof AgentsBoard>;

const EMPTY = deriveAgents([]);
const live = boardArgs(untilProposal(RECORDINGS[0]!.agent, 'ap-msg-1'), { live: true });
const ended = boardArgs(SHOWCASE_EVENTS);
const pivot = ended.model.columns.flatMap((c) => c.rows).find((r) => r.kind === 'decision')!;

export const Empty: Story = { args: { ...boardArgs([]), model: EMPTY } };
export const Loading: Story = { args: { ...boardArgs([]), model: EMPTY, loadStatus: 'loading' } };
export const Live: Story = { name: 'Live (a decision is waiting)', args: live };
export const Ended: Story = { name: 'Live (every row type, author banner)', args: ended };
export const History: Story = {
  name: 'History (viewing a past moment)',
  args: { ...ended, cursorSeq: pivot.seq },
};
export const HideThoughts: Story = { name: 'Hide thoughts', args: { ...ended, hideThoughts: true } };
export const ErrorState: Story = {
  name: 'Error',
  args: { ...boardArgs([]), model: EMPTY, loadStatus: 'error', error: 'The API returned 503; retrying.' },
};
