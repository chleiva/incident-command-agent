/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { Frame, S01, S04, fourStates, pendingApproval } from '../../stories/support';
import { OptionsMatrix } from './OptionsMatrix';

const meta: Meta<typeof OptionsMatrix> = { title: 'Zones/Decisions/OptionsMatrix', component: OptionsMatrix };
export default meta;
type Story = StoryObj<typeof OptionsMatrix>;

const s04 = pendingApproval(S04.agent, 'ap4-decision-1').approval.options!;
const s01 = pendingApproval(S01.agent, 'ap-decision-1').approval.options!;
const s = fourStates(
  () => <OptionsMatrix options={s04} onSelect={fn()} />,
  () => <OptionsMatrix options={[]} onSelect={fn()} />,
  (n) => (
    <Frame title="Alternatives" width={460}>
      {n}
    </Frame>
  ),
);
export const Empty: Story = s.Empty;
export const Loading: Story = s.Loading;
export const Live: Story = { ...s.Live, name: 'Live (s04: four options)' };
export const ErrorState: Story = s.ErrorState;
export const Chosen: Story = {
  name: 'Live (s01, chosen, wide)',
  render: () => (
    <Frame title="Alternatives" width={760}>
      <OptionsMatrix options={s01} selectedId="opt-swap" disabled onSelect={fn()} />
    </Frame>
  ),
};
