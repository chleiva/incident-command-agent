/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** "What is happening?" The agents' work, interleaved by time (newest first), filterable by role and type. */
import type { AgentRole } from '@ica/schema/browser';
import { AnimatePresence, motion } from 'framer-motion';
import { useMemo, useState } from 'react';
import { matchesFilter, type FeedFilter, type FeedItem } from '../../lib/derive';
import { StateFrame, cx, type LoadStatus } from '../ui/primitives';
import { AgentAvatarRow, type RoleState } from './AgentAvatarRow';
import { FeedLine, ToolCallCard } from './ToolCallCard';

const FILTERS: { id: FeedFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'tools', label: 'Tools' },
  { id: 'decisions', label: 'Decisions' },
  { id: 'blocks', label: 'Blocks' },
  { id: 'reports', label: 'Reports' },
];

export function AgentStream({
  items,
  roleStates,
  status = 'ready',
  error,
  pageSize = 40,
}: {
  items: FeedItem[];
  roleStates: Map<AgentRole, Exclude<RoleState, 'idle'>>;
  status?: LoadStatus;
  error?: string | null;
  pageSize?: number;
}) {
  const [hidden, setHidden] = useState<Set<AgentRole>>(new Set());
  const [filter, setFilter] = useState<FeedFilter>('all');
  const [limit, setLimit] = useState(pageSize);
  const visible = useMemo(
    () =>
      items
        .filter((i) => i.role === 'world' || !hidden.has(i.role))
        .filter((i) => matchesFilter(i, filter))
        .reverse(),
    [items, hidden, filter],
  );
  const toggle = (role: AgentRole) => {
    const next = new Set(hidden);
    if (next.has(role)) next.delete(role);
    else next.add(role);
    setHidden(next);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 px-3 py-2">
        <AgentAvatarRow states={roleStates} hidden={hidden} onToggle={toggle} />
        <div
          role="radiogroup"
          aria-label="Filter by type"
          className="ml-auto flex rounded-md bg-surface-sunken p-0.5"
        >
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              role="radio"
              aria-checked={filter === f.id}
              onClick={() => setFilter(f.id)}
              className={cx(
                'h-6 rounded-sm px-2 text-micro',
                filter === f.id ? 'bg-surface-hover text-fg' : 'text-fg-muted hover:text-fg',
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>
      <div className="zone-scroll min-h-0 flex-1 px-3 pb-3">
        <StateFrame
          status={status}
          error={error}
          empty={visible.length === 0}
          emptyText={
            items.length
              ? 'No activity matches this filter.'
              : 'Agents will appear here once the incident starts.'
          }
        >
          <ol className="flex flex-col gap-2" aria-label="Agent activity, newest first">
            <AnimatePresence initial={false}>
              {visible.slice(0, limit).map((item) => (
                <motion.li
                  key={item.key}
                  layout="position"
                  initial={{ opacity: 0, y: -6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.2 }}
                >
                  {item.kind === 'tool' ? <ToolCallCard item={item} /> : <FeedLine item={item} />}
                </motion.li>
              ))}
            </AnimatePresence>
          </ol>
          {visible.length > limit && (
            <button
              type="button"
              onClick={() => setLimit(limit + pageSize)}
              className="mt-2 w-full rounded-md py-1 text-caption text-fg-muted hover:bg-surface-hover hover:text-fg"
            >
              Show {Math.min(pageSize, visible.length - limit)} older
            </button>
          )}
        </StateFrame>
      </div>
    </div>
  );
}
