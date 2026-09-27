/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { ColumnHeader } from './ColumnHeader';

const meta: Meta<typeof ColumnHeader> = {
  title: 'Agents view/Column header',
  component: ColumnHeader,
  decorators: [
    (Story) => (
      <div style={{ width: 300 }} className="rounded-lg border border-border bg-surface">
        <Story />
      </div>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof ColumnHeader>;

export const Working: Story = { args: { role: 'maintenance', status: 'working', turns: 3 } };
export const Waiting: Story = { args: { role: 'passenger', status: 'waiting', turns: 2 } };
export const Blocked: Story = { args: { role: 'ground', status: 'blocked', turns: 7 } };
export const Done: Story = { args: { role: 'flightops', status: 'done', turns: 4 } };
export const NotStarted: Story = { args: { role: 'record', status: null, turns: 0 } };
