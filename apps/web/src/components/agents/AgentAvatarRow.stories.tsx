/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { activeRoles } from '../../lib/derive';
import { END, ROLES_MID, fourStates } from '../../stories/support';
import { AgentAvatarRow } from './AgentAvatarRow';

const meta: Meta<typeof AgentAvatarRow> = { title: 'Zones/Agents/AgentAvatarRow', component: AgentAvatarRow };
export default meta;
type Story = StoryObj<typeof AgentAvatarRow>;

const s = fourStates(
  () => (
    <div className="flex flex-col gap-3">
      <AgentAvatarRow states={ROLES_MID} onToggle={fn()} />
      <AgentAvatarRow states={activeRoles(END.view)} hidden={new Set(['record'])} onToggle={fn()} />
    </div>
  ),
  () => <AgentAvatarRow states={new Map()} onToggle={fn()} />,
  (n) => <div className="w-80">{n}</div>,
);
export const Empty: Story = { ...s.Empty, name: 'Empty (idle)' };
export const Loading: Story = s.Loading;
export const Live: Story = { ...s.Live, name: 'Live (working / awaiting · done, one filtered)' };
export const ErrorState: Story = s.ErrorState;
