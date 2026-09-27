/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** Role avatar (initials). All agents share the AI accent; only activity lights it up. */
import type { AgentRole } from '@ica/schema/browser';
import { ROLE_INITIALS, ROLE_LABEL } from '../../lib/format';
import { cx } from '../ui/primitives';

export function AgentMark({
  role,
  size = 24,
  state = 'idle',
  decorative = true,
}: {
  role: AgentRole | 'world';
  size?: number;
  state?: 'idle' | 'running' | 'awaiting_approval' | 'done' | 'aborted';
  decorative?: boolean;
}) {
  const label = role === 'world' ? 'World' : ROLE_LABEL[role];
  const initials = role === 'world' ? 'W' : ROLE_INITIALS[role];
  const active = state === 'running' || state === 'awaiting_approval';
  return (
    <span
      role={decorative ? undefined : 'img'}
      aria-hidden={decorative || undefined}
      aria-label={decorative ? undefined : `${label}: ${state.replace('_', ' ')}`}
      title={`${label}${state !== 'idle' ? ` · ${state.replace('_', ' ')}` : ''}`}
      className={cx(
        'relative inline-flex shrink-0 select-none items-center justify-center rounded-md font-semibold',
        active
          ? 'bg-ai-bg text-ai ring-1 ring-ai/70'
          : state === 'done'
            ? 'bg-surface-hover text-fg-muted'
            : 'bg-surface-hover text-fg-subtle',
        state === 'aborted' && 'text-critical',
      )}
      style={{ width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.4)) }}
    >
      {initials}
      {active && (
        <span
          className={cx(
            'absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full ring-2 ring-surface',
            state === 'awaiting_approval' ? 'bg-warning' : 'animate-soft-pulse bg-ai',
          )}
          aria-hidden
        />
      )}
    </span>
  );
}
