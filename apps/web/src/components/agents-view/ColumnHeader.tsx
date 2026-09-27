/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** Agent column header (task 08): full name (abbrev), a one-line objective, a status dot and the turn count. */
import type { AgentRole } from '@ica/schema/browser';
import { STATUS_LABEL, type ColumnStatus } from '../../agents/rows';
import { roleInfo, roleName } from '../../agents/roles';
import { cx } from '../ui/primitives';

const DOT: Record<ColumnStatus, string> = {
  working: 'bg-ai animate-soft-pulse',
  waiting: 'bg-warning',
  blocked: 'bg-critical',
  done: 'bg-good',
};

export function ColumnHeader({
  role,
  status,
  turns,
  id,
}: {
  role: AgentRole;
  status: ColumnStatus | null;
  turns: number;
  id?: string;
}) {
  const info = roleInfo(role);
  return (
    <header className="flex flex-col gap-0.5 border-b border-border px-3 py-2" data-column-header={role}>
      <h2 id={id} className="truncate text-body-lg font-semibold text-fg" title={roleName(role)}>
        {roleName(role)}
      </h2>
      <p className="flex items-center gap-[6px] text-micro text-fg-muted" data-status={status ?? 'idle'}>
        <span
          className={cx('h-2 w-2 shrink-0 rounded-full', status ? DOT[status] : 'bg-fg-subtle')}
          aria-hidden
        />
        <span>{status ? STATUS_LABEL[status] : 'Not started'}</span>
        <span className="num text-fg-subtle" data-turns>
          · {turns} {turns === 1 ? 'turn' : 'turns'}
        </span>
      </p>
      <p className="truncate text-caption text-fg-subtle" title={info.objective}>
        {info.objective}
      </p>
    </header>
  );
}
