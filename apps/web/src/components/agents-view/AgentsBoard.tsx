/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * The Agents view body (task 08): the Scenario Author banner and up to six equal-width agent columns, ordered by
 * first activity (horizontal scroll below 1400 px). Keyboard: arrows move between rows and columns, Enter expands,
 * Escape collapses, `[` / `]` switch columns. One expanded row per column. Selecting a row moves the scrubber
 * (`onSelectRow`); delegation links jump between "→ briefed X" and "← brief from Orchestrator".
 */
import type { AgentRole } from '@ica/schema/browser';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  factsFor,
  reasoningFor,
  type AgentRow,
  type AgentsModel,
  type ColumnStatus,
} from '../../agents/rows';
import { StateFrame, type LoadStatus } from '../ui/primitives';
import { AgentColumnView, type ColumnHandle } from './AgentColumnView';
import { AuthorBanner } from './AuthorBanner';
import { RowDetail } from './RowDetail';

/** Minimum column width before the board scrolls horizontally (six columns ≈ 1400 px). */
export const MIN_COLUMN_PX = 224;
const HIGHLIGHT_MS = 2_500;

/** "What it decided", in plain words (never model text). */
export function decidedText(row: AgentRow): string {
  switch (row.kind) {
    case 'thought':
      return 'It reasoned about what to do next; no action in this row.';
    case 'brief':
      return row.link ? 'It received its brief and started work.' : 'It started coordinating the response.';
    case 'tool':
      return `${row.headline}.${row.failed ? ' The system returned an error.' : ' It ran this itself (allowed without approval).'}`;
    case 'proposal':
      return `${row.headline}. This needs a person's approval before anything happens.`;
    case 'waiting':
      return 'It paused this action until a person decides.';
    case 'decision':
      return `${row.headline}.`;
    case 'invalidated':
      return 'A fact the approval relied on changed, so the approval no longer holds.';
    case 'blocked':
      return `${row.headline}. The guardrail refused it; nothing was changed.`;
    case 'stopped':
      return `${row.headline}. The agent did no further work.`;
    case 'report':
      return 'It finished and reported back.';
  }
}

export interface AgentsBoardProps {
  model: AgentsModel;
  statusByRole: Partial<Record<AgentRole, ColumnStatus | null>>;
  turnsByRole: Partial<Record<AgentRole, number>>;
  cursorSeq: number | null;
  hideThoughts: boolean;
  /** Announce new rows (live mode). */
  live?: boolean;
  loadStatus?: LoadStatus;
  error?: string | null;
  onSelectRow?: (row: AgentRow) => void;
  decisionHref?: string;
  onOpenDecisions?: () => void;
  /** Force virtualisation (stories/tests). */
  virtualize?: boolean;
}

export function AgentsBoard({
  model,
  statusByRole,
  turnsByRole,
  cursorSeq,
  hideThoughts,
  live = true,
  loadStatus = 'ready',
  error,
  onSelectRow,
  decisionHref,
  onOpenDecisions,
  virtualize,
}: AgentsBoardProps) {
  const columns = useMemo(
    () =>
      model.columns.map((c) => ({
        role: c.role,
        rows: hideThoughts ? c.rows.filter((r) => r.kind !== 'thought') : c.rows,
      })),
    [model, hideThoughts],
  );
  const [expanded, setExpanded] = useState<Partial<Record<AgentRole, string | null>>>({});
  const [highlight, setHighlight] = useState<string | null>(null);
  /** The active row of each column: its single tab stop (roving tabindex), remembered for `[` / `]`. */
  const [active, setActive] = useState<Partial<Record<AgentRole, string>>>({});
  const activate = useCallback((role: AgentRole, key: string) => {
    setActive((a) => (a[role] === key ? a : { ...a, [role]: key }));
  }, []);
  const refs = useRef(new Map<AgentRole, ColumnHandle>());

  const tabKeyOf = (role: AgentRole, rows: AgentRow[]) => {
    const key = active[role];
    return key && rows.some((r) => r.key === key) ? key : (rows[0]?.key ?? null);
  };

  useEffect(() => {
    if (!highlight) return;
    const t = setTimeout(() => setHighlight(null), HIGHLIGHT_MS);
    return () => clearTimeout(t);
  }, [highlight]);

  const focusRow = useCallback(
    (role: AgentRole, key: string) => {
      activate(role, key);
      refs.current.get(role)?.reveal(key, { focus: true });
    },
    [activate],
  );

  const toggle = (row: AgentRow) => {
    const open = expanded[row.role] === row.key;
    setExpanded({ ...expanded, [row.role]: open ? null : row.key });
    activate(row.role, row.key);
    if (!open) onSelectRow?.(row);
  };

  const followLink = (row: AgentRow) => {
    const target = row.link ? model.rowByKey.get(row.link.targetKey) : undefined;
    if (!target) return;
    setHighlight(target.key);
    focusRow(target.role, target.key);
  };

  const onRowKeyDown = (e: KeyboardEvent<HTMLButtonElement>, row: AgentRow) => {
    const ci = columns.findIndex((c) => c.role === row.role);
    const col = columns[ci];
    if (!col) return;
    const i = col.rows.findIndex((r) => r.key === row.key);
    const toColumn = (nextCi: number, pick: (rows: AgentRow[], role: AgentRole) => AgentRow | undefined) => {
      const next = columns[nextCi];
      if (!next) return;
      const target = pick(next.rows, next.role);
      if (target) focusRow(next.role, target.key);
    };
    const nearest = (rows: AgentRow[]) =>
      rows.reduce<AgentRow | undefined>(
        (best, r) => (!best || Math.abs(r.seq - row.seq) < Math.abs(best.seq - row.seq) ? r : best),
        undefined,
      );
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (col.rows[i + 1]) focusRow(col.role, col.rows[i + 1]!.key);
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (i > 0) focusRow(col.role, col.rows[i - 1]!.key);
        break;
      case 'Home':
        e.preventDefault();
        if (col.rows[0]) focusRow(col.role, col.rows[0].key);
        break;
      case 'End':
        e.preventDefault();
        if (col.rows.at(-1)) focusRow(col.role, col.rows.at(-1)!.key);
        break;
      case 'ArrowRight':
        e.preventDefault();
        toColumn(ci + 1, nearest);
        break;
      case 'ArrowLeft':
        e.preventDefault();
        toColumn(ci - 1, nearest);
        break;
      case ']':
      case '[': {
        e.preventDefault();
        const nextCi = e.key === ']' ? ci + 1 : ci - 1;
        toColumn(nextCi, (rows, role) => {
          const remembered = active[role];
          return rows.find((r) => r.key === remembered) ?? rows[0];
        });
        break;
      }
      case 'Escape':
        if (expanded[row.role]) {
          e.preventDefault();
          const open = expanded[row.role]!;
          setExpanded({ ...expanded, [row.role]: null });
          focusRow(row.role, open);
        }
        break;
      default:
        break;
    }
  };

  const renderDetail = (row: AgentRow, detailId: string) => (
    <RowDetail
      id={detailId}
      row={row}
      facts={factsFor(model, row)}
      reasoning={reasoningFor(model, row)}
      decided={decidedText(row)}
    />
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      {model.author && <AuthorBanner author={model.author} />}
      <StateFrame
        status={loadStatus}
        error={error}
        empty={columns.length === 0}
        emptyText="The agents' columns appear as soon as the first agent starts."
      >
        <div className="min-h-0 flex-1 overflow-x-auto" data-testid="agents-board">
          <div
            className="grid h-full gap-2"
            style={{
              gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))`,
              minWidth: columns.length * MIN_COLUMN_PX,
            }}
          >
            {columns.map((c) => (
              <AgentColumnView
                key={c.role}
                ref={(h) => {
                  if (h) refs.current.set(c.role, h);
                  else refs.current.delete(c.role);
                }}
                role={c.role}
                rows={c.rows}
                status={statusByRole[c.role] ?? null}
                turns={turnsByRole[c.role] ?? 0}
                expandedKey={expanded[c.role] ?? null}
                focusedKey={tabKeyOf(c.role, c.rows)}
                highlightedKey={highlight}
                cursorSeq={cursorSeq}
                announce={live}
                renderDetail={renderDetail}
                onToggle={toggle}
                onFocusRow={(r) => activate(r.role, r.key)}
                onRowKeyDown={onRowKeyDown}
                onFollowLink={followLink}
                decisionHref={decisionHref}
                onOpenDecisions={onOpenDecisions}
                virtualize={virtualize}
              />
            ))}
          </div>
        </div>
      </StateFrame>
    </div>
  );
}
