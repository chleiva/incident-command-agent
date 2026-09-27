/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { factsFor, reasoningFor } from '../../agents/rows';
import { AgentColumnView } from './AgentColumnView';
import { decidedText } from './AgentsBoard';
import { RowDetail } from './RowDetail';
import { SHOWCASE_MODEL } from './storyData';

function ColumnStory({
  role,
  loadStatus = 'ready',
  empty = false,
}: {
  role: 'passenger' | 'ground' | 'maintenance';
  loadStatus?: 'ready' | 'loading' | 'error';
  empty?: boolean;
}) {
  const col = SHOWCASE_MODEL.columns.find((c) => c.role === role)!;
  const rows = empty ? [] : col.rows;
  const [expanded, setExpanded] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(rows[0]?.key ?? null);
  return (
    <div style={{ width: 320, height: 720 }} className="flex flex-col">
      <AgentColumnView
        role={role}
        rows={rows}
        status={empty ? null : role === 'ground' ? 'blocked' : 'done'}
        turns={empty ? 0 : 5}
        expandedKey={expanded}
        focusedKey={focused}
        cursorSeq={null}
        loadStatus={loadStatus}
        error={loadStatus === 'error' ? 'The API returned 503; retrying.' : null}
        renderDetail={(row, id) => (
          <RowDetail
            id={id}
            row={row}
            facts={factsFor(SHOWCASE_MODEL, row)}
            reasoning={reasoningFor(SHOWCASE_MODEL, row)}
            decided={decidedText(row)}
          />
        )}
        onToggle={(r) => setExpanded(expanded === r.key ? null : r.key)}
        onFocusRow={(r) => setFocused(r.key)}
        onRowKeyDown={() => {}}
        onFollowLink={() => {}}
      />
    </div>
  );
}

const meta: Meta<typeof ColumnStory> = {
  title: 'Agents view/Column',
  component: ColumnStory,
};
export default meta;
type Story = StoryObj<typeof ColumnStory>;

export const Empty: Story = { args: { role: 'maintenance', empty: true } };
export const Loading: Story = { args: { role: 'maintenance', loadStatus: 'loading' } };
export const Live: Story = { name: 'Live (passengers: waits and decisions)', args: { role: 'passenger' } };
export const Stopped: Story = { name: 'Live (ground: stopped by a limit)', args: { role: 'ground' } };
export const ErrorState: Story = { name: 'Error', args: { role: 'maintenance', loadStatus: 'error' } };
