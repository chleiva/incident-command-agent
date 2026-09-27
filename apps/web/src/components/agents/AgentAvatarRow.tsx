/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** Who is working: one avatar per role, lit between `agent.started` and `agent.report`. Click to filter. */
import type { AgentRole } from '@ica/schema/browser';
import { ROLE_LABEL } from '../../lib/format';
import { cx } from '../ui/primitives';
import { AgentMark } from './AgentMark';

export const STREAM_ROLES: AgentRole[] = [
  'orchestrator',
  'maintenance',
  'ground',
  'flightops',
  'passenger',
  'record',
];

export type RoleState = 'idle' | 'running' | 'awaiting_approval' | 'done' | 'aborted';

export function AgentAvatarRow({
  states,
  hidden = new Set(),
  onToggle,
}: {
  states: Map<AgentRole, Exclude<RoleState, 'idle'>>;
  hidden?: Set<AgentRole>;
  onToggle?: (role: AgentRole) => void;
}) {
  return (
    <div role="group" aria-label="Agents (toggle a role to filter)" className="flex items-center gap-1">
      {STREAM_ROLES.map((role) => {
        const state: RoleState = states.get(role) ?? 'idle';
        const off = hidden.has(role);
        return (
          <button
            key={role}
            type="button"
            aria-pressed={!off}
            aria-label={`${ROLE_LABEL[role]} agent — ${state.replace('_', ' ')}. ${off ? 'Hidden' : 'Shown'} in the stream`}
            onClick={() => onToggle?.(role)}
            className={cx('rounded-md p-0.5', off && 'outline-dashed outline-1 outline-border-control')}
          >
            <AgentMark role={role} state={off ? 'idle' : state} size={24} />
          </button>
        );
      })}
    </div>
  );
}
