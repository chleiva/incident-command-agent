/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { Frame, S01, fourStates, pendingApproval } from '../../stories/support';
import { DiffEditor } from './DiffEditor';

const meta: Meta<typeof DiffEditor> = { title: 'Zones/Decisions/DiffEditor', component: DiffEditor };
export default meta;
type Story = StoryObj<typeof DiffEditor>;

const args = pendingApproval(S01.agent, 'ap-msg-2').approval.args;
const s = fourStates(
  () => <DiffEditor original={args} onSubmit={fn()} onCancel={fn()} />,
  () => <DiffEditor original={{}} onSubmit={fn()} onCancel={fn()} />,
  (n) => (
    <Frame title="Edit payload" width={460}>
      {n}
    </Frame>
  ),
);
export const Empty: Story = s.Empty;
export const Loading: Story = s.Loading;
export const Live: Story = s.Live;
export const ErrorState: Story = s.ErrorState;
