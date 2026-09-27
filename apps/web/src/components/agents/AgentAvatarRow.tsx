/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** Who is working: one avatar per role, lit between `agent.started` and `agent.report`. Click to filter. */
import * as Tooltip from '@radix-ui/react-tooltip';
import type { AgentRole } from '@ica/schema/browser';
import { roleName } from '../../agents/roles';
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
    <Tooltip.Provider delayDuration={200} skipDelayDuration={100}>
      <div role="group" aria-label="Agents (toggle a role to filter)" className="flex items-center gap-1">
        {STREAM_ROLES.map((role) => {
          const state: RoleState = states.get(role) ?? 'idle';
          const off = hidden.has(role);
          return (
            <Tooltip.Root key={role}>
              <Tooltip.Trigger asChild>
                <button
                  type="button"
                  aria-pressed={!off}
                  aria-label={`${roleName(role)} agent — ${state.replace('_', ' ')}. ${off ? 'Hidden' : 'Shown'} in the stream`}
                  data-agent-chip={role}
                  onClick={() => onToggle?.(role)}
                  className={cx('rounded-md p-0.5', off && 'outline-dashed outline-1 outline-border-control')}
                >
                  <AgentMark role={role} state={off ? 'idle' : state} size={24} titled={false} />
                </button>
              </Tooltip.Trigger>
              <Tooltip.Portal>
                <Tooltip.Content
                  side="bottom"
                  sideOffset={4}
                  collisionPadding={8}
                  className="z-[80] rounded-md border border-border bg-surface-raised px-2 py-1 text-caption text-fg shadow-e2"
                >
                  {roleName(role)}
                  <Tooltip.Arrow className="fill-surface-raised" />
                </Tooltip.Content>
              </Tooltip.Portal>
            </Tooltip.Root>
          );
        })}
      </div>
    </Tooltip.Provider>
  );
}
