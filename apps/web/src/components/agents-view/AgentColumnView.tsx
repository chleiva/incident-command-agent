/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * One agent's column (task 08): a list of rows, oldest at the top. It follows the newest row unless the viewer has
 * scrolled up ("Jump to latest"), announces new rows in a polite live region, and virtualises long lists so long
 * runs stay smooth.
 */
import type { AgentRole } from '@ica/schema/browser';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import type { AgentRow, ColumnStatus } from '../../agents/rows';
import { roleName } from '../../agents/roles';
import { Icon } from '../ui/Icon';
import { StateFrame, type LoadStatus } from '../ui/primitives';
import { AgentRowView } from './AgentRowView';
import { ColumnHeader } from './ColumnHeader';
import { plainText } from '../../lib/announce';

/** Lists longer than this render only the rows in view (plus overscan). */
export const VIRTUALIZE_AFTER = 40;
const AT_BOTTOM_PX = 24;

export interface ColumnHandle {
  /** Scroll a row into view and optionally focus it. */
  reveal(key: string, opts?: { focus?: boolean }): void;
}

export interface AgentColumnViewProps {
  role: AgentRole;
  rows: AgentRow[];
  status: ColumnStatus | null;
  turns: number;
  expandedKey: string | null;
  focusedKey: string | null;
  highlightedKey?: string | null;
  cursorSeq: number | null;
  /** Announce new rows (live mode). */
  announce?: boolean;
  loadStatus?: LoadStatus;
  error?: string | null;
  renderDetail: (row: AgentRow, detailId: string) => ReactNode;
  onToggle: (row: AgentRow) => void;
  onFocusRow: (row: AgentRow) => void;
  onRowKeyDown: (e: KeyboardEvent<HTMLButtonElement>, row: AgentRow) => void;
  onFollowLink: (row: AgentRow) => void;
  /** History mode: actions after the viewed moment (hidden), with a "Back to live" footer. */
  later?: number;
  onLive?: () => void;
  /** Approvals pending at the head: only those waiting rows link to the decision rail. */
  livePendingIds?: ReadonlySet<string>;
  decisionHref?: string;
  onOpenDecisions?: () => void;
  /** Force virtualisation on or off (default: on above `VIRTUALIZE_AFTER` rows). */
  virtualize?: boolean;
}

export const AgentColumnView = forwardRef<ColumnHandle, AgentColumnViewProps>(function AgentColumnView(
  {
    role,
    rows,
    status,
    turns,
    expandedKey,
    focusedKey,
    highlightedKey,
    cursorSeq,
    announce = false,
    loadStatus = 'ready',
    error,
    renderDetail,
    onToggle,
    onFocusRow,
    onRowKeyDown,
    onFollowLink,
    later = 0,
    onLive,
    livePendingIds,
    decisionHref,
    onOpenDecisions,
    virtualize,
  },
  ref,
) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const virtual = virtualize ?? rows.length > VIRTUALIZE_AFTER;
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 64,
    overscan: 8,
    enabled: virtual,
    getItemKey: (i) => rows[i]!.key,
    initialRect: { width: 300, height: 800 },
  });

  // ------------------------------------------------------------------ follow the newest row
  const stick = useRef(true);
  const [behind, setBehind] = useState(0);
  const lastCount = useRef(rows.length);
  const [liveText, setLiveText] = useState('');

  const scrollToEnd = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (virtual && rows.length) virtualizer.scrollToIndex(rows.length - 1, { align: 'end' });
    el.scrollTop = el.scrollHeight;
  }, [rows.length, virtual, virtualizer]);

  useLayoutEffect(() => {
    const added = rows.length - lastCount.current;
    lastCount.current = rows.length;
    if (added <= 0) return;
    if (stick.current) scrollToEnd();
    else setBehind((b) => b + added);
    const newest = rows.at(-1);
    if (announce && newest) setLiveText(plainText(`${roleName(role)}: ${newest.headline}`));
  }, [rows, announce, role, scrollToEnd]);

  useEffect(() => {
    scrollToEnd();
    // Only on mount: start at the newest row.
  }, []);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < AT_BOTTOM_PX;
    stick.current = atBottom;
    if (atBottom) setBehind(0);
  };

  // ------------------------------------------------------------------ imperative reveal (keyboard, links)
  useImperativeHandle(
    ref,
    () => ({
      reveal(key, opts) {
        const idx = rows.findIndex((r) => r.key === key);
        if (idx < 0) return;
        stick.current = idx === rows.length - 1;
        const focus = () => {
          const b = buttons.current.get(key);
          if (!b) return false;
          b.scrollIntoView?.({ block: 'nearest' });
          if (opts?.focus) b.focus({ preventScroll: true });
          return true;
        };
        if (focus()) return;
        if (virtual) virtualizer.scrollToIndex(idx, { align: 'center' });
        let tries = 0;
        const retry = () => {
          if (focus() || ++tries > 10) return;
          requestAnimationFrame(retry);
        };
        requestAnimationFrame(retry);
      },
    }),
    [rows, virtual, virtualizer],
  );

  const renderRow = (row: AgentRow) => {
    const detailId = `detail-${row.key}`;
    // Decide only on what is pending NOW (a row pending at a past moment may have been decided since).
    const canDecide = !livePendingIds || (!!row.approvalId && livePendingIds.has(row.approvalId));
    return (
      <AgentRowView
        ref={(el) => {
          if (el) buttons.current.set(row.key, el);
          else buttons.current.delete(row.key);
        }}
        row={row}
        expanded={expandedKey === row.key}
        focused={focusedKey === row.key}
        highlighted={highlightedKey === row.key}
        future={cursorSeq !== null && row.seq > cursorSeq}
        detailId={detailId}
        onToggle={() => onToggle(row)}
        onFocus={() => onFocusRow(row)}
        onKeyDown={(e) => onRowKeyDown(e, row)}
        onFollowLink={row.link ? () => onFollowLink(row) : undefined}
        decisionHref={canDecide ? decisionHref : undefined}
        onOpenDecisions={canDecide ? onOpenDecisions : undefined}
      >
        {expandedKey === row.key ? renderDetail(row, detailId) : null}
      </AgentRowView>
    );
  };

  const headerId = `col-${role}-title`;
  const items = virtual ? virtualizer.getVirtualItems() : [];
  return (
    <section
      aria-labelledby={headerId}
      data-column={role}
      className="relative flex min-h-0 min-w-0 flex-col rounded-lg border border-border bg-surface shadow-e1"
    >
      <ColumnHeader role={role} status={status} turns={turns} id={headerId} />
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="zone-scroll relative min-h-0 flex-1 p-2"
        data-column-body
      >
        <StateFrame
          status={loadStatus}
          error={error}
          empty={rows.length === 0}
          emptyText="Nothing to show yet."
        >
          {virtual ? (
            <ol
              aria-label={`${roleName(role)} actions, oldest first`}
              className="relative"
              style={{ height: virtualizer.getTotalSize() }}
            >
              {items.map((v) => {
                const row = rows[v.index]!;
                return (
                  <li
                    key={row.key}
                    data-index={v.index}
                    ref={virtualizer.measureElement}
                    className="absolute inset-x-0 top-0 pb-[6px]"
                    style={{ transform: `translateY(${v.start}px)` }}
                  >
                    {renderRow(row)}
                  </li>
                );
              })}
            </ol>
          ) : (
            <ol aria-label={`${roleName(role)} actions, oldest first`} className="flex flex-col gap-[6px]">
              {rows.map((row) => (
                <li key={row.key}>{renderRow(row)}</li>
              ))}
            </ol>
          )}
        </StateFrame>
      </div>
      {later > 0 && (
        <div
          className="flex shrink-0 items-center justify-center gap-1 border-t border-dashed border-border px-2 py-1.5 text-caption text-fg-muted"
          data-later-footer
        >
          <span data-later-count={later}>
            {later} later action{later === 1 ? '' : 's'}
          </span>
          {onLive && (
            <>
              <span aria-hidden> — </span>
              <button
                type="button"
                onClick={onLive}
                className="text-fg underline decoration-border-control underline-offset-2 hover:decoration-fg"
              >
                Back to live
              </button>
            </>
          )}
        </div>
      )}
      {behind > 0 && (
        <button
          type="button"
          onClick={() => {
            stick.current = true;
            setBehind(0);
            scrollToEnd();
          }}
          className="absolute bottom-3 left-1/2 inline-flex -translate-x-1/2 items-center gap-1 rounded-full bg-fg px-3 py-1 text-caption font-medium text-bg shadow-e2"
        >
          <Icon name="chevronDown" size={12} /> Jump to latest ({behind})
        </button>
      )}
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {liveText}
      </p>
    </section>
  );
});
