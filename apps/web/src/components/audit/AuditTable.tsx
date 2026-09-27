/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * The audit table: one row per LLM call or tool call, chronological, virtualised for long runs. Keyboard: ↑/↓ move
 * between rows, Home/End jump, Enter/Space expand, Escape inside an expanded row collapses it and returns focus.
 */
import type { AuditEntry } from '@ica/schema/browser';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useEffect, useRef, type KeyboardEvent } from 'react';
import { agentLabel, entrySummary, outcomeLabel, turnLabel } from '../../audit/audit';
import { simClockAt } from '../../lib/format';
import { Icon } from '../ui/Icon';
import { Badge, TierBadge, cx } from '../ui/primitives';
import { AuditEntryDetail, type TraceLoader } from './AuditEntryDetail';

export const AUDIT_VIRTUALIZE_AFTER = 80;

const COLS =
  'grid grid-cols-[5.5rem_minmax(7rem,10rem)_minmax(7rem,10rem)_3rem_6.5rem_minmax(0,1fr)_minmax(6rem,17rem)] gap-x-3';
const HEADERS = ['Sim time', 'Run', 'Agent', 'Turn', 'Kind', 'Summary', 'Tier / decision'];

export interface AuditTableProps {
  entries: AuditEntry[];
  runName: string;
  startSimTime?: string;
  expanded: ReadonlySet<string>;
  onToggle(id: string): void;
  loadTrace: TraceLoader;
  /** Force (or disable) virtualisation; default: more than `AUDIT_VIRTUALIZE_AFTER` rows. */
  virtualize?: boolean;
}

export function AuditTable({
  entries,
  runName,
  startSimTime,
  expanded,
  onToggle,
  loadTrace,
  virtualize,
}: AuditTableProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtual = virtualize ?? entries.length > AUDIT_VIRTUALIZE_AFTER;
  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 40,
    overscan: 10,
    enabled: virtual,
    getItemKey: (i) => entries[i]!.id,
    initialRect: { width: 1200, height: 800 },
  });
  const pendingFocus = useRef<string | null>(null);

  const focusRow = useCallback(
    (index: number) => {
      const e = entries[index];
      if (!e) return;
      pendingFocus.current = e.id;
      if (virtual) virtualizer.scrollToIndex(index, { align: 'auto' });
      requestAnimationFrame(() => {
        const btn = scrollRef.current?.querySelector<HTMLButtonElement>(
          `[data-audit-toggle="${CSS.escape(e.id)}"]`,
        );
        if (btn) {
          btn.focus();
          pendingFocus.current = null;
        }
      });
    },
    [entries, virtual, virtualizer],
  );

  // A row scrolled into view after a keyboard jump gets the focus once it is rendered.
  useEffect(() => {
    const id = pendingFocus.current;
    if (!id) return;
    const btn = scrollRef.current?.querySelector<HTMLButtonElement>(
      `[data-audit-toggle="${CSS.escape(id)}"]`,
    );
    if (btn) {
      btn.focus();
      pendingFocus.current = null;
    }
  });

  const onRowKey = (ev: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const to =
      ev.key === 'ArrowDown'
        ? index + 1
        : ev.key === 'ArrowUp'
          ? index - 1
          : ev.key === 'Home'
            ? 0
            : ev.key === 'End'
              ? entries.length - 1
              : null;
    if (to === null) return;
    ev.preventDefault();
    focusRow(Math.max(0, Math.min(entries.length - 1, to)));
  };

  const renderRow = (e: AuditEntry, index: number) => {
    const open = expanded.has(e.id);
    const detailId = `audit-detail-${index}`;
    const kind = e.kind === 'llm' ? 'LLM call' : 'Tool call';
    const outcome = e.kind === 'tool' ? outcomeLabel(e) : null;
    const time = e.simMinute === undefined ? '—' : simClockAt(startSimTime ?? null, e.simMinute);
    return (
      <div
        role="row"
        aria-rowindex={index + 2}
        data-audit-row={e.id}
        data-kind={e.kind}
        className={cx(
          COLS,
          'items-center border-b border-border px-2 py-1 text-body',
          open ? 'bg-surface-raised' : 'hover:bg-surface-hover',
        )}
      >
        <div role="cell" className="min-w-0">
          <button
            type="button"
            data-audit-toggle={e.id}
            aria-expanded={open}
            aria-controls={open ? detailId : undefined}
            aria-label={`${open ? 'Collapse' : 'Expand'} ${kind.toLowerCase()} by ${agentLabel(e)} ${turnLabel(e)} at ${time}`}
            onClick={() => onToggle(e.id)}
            onKeyDown={(ev) => onRowKey(ev, index)}
            className="inline-flex items-center gap-1 rounded-sm font-mono text-caption text-fg"
          >
            <Icon name={open ? 'chevronDown' : 'chevronRight'} size={11} />
            {time}
          </button>
        </div>
        <div role="cell" className="truncate text-caption text-fg-muted" title={runName}>
          {runName}
        </div>
        <div role="cell" className="truncate text-caption text-fg">
          {agentLabel(e)}
        </div>
        <div role="cell" className="font-mono text-caption text-fg-muted">
          {turnLabel(e)}
        </div>
        <div role="cell">
          <Badge tone={e.kind === 'llm' ? 'ai' : 'neutral'} icon={e.kind === 'llm' ? 'sparkle' : 'wrench'}>
            {kind}
          </Badge>
        </div>
        <div role="cell" className="min-w-0 truncate text-caption text-fg" title={entrySummary(e)}>
          {e.kind === 'tool' && <span className="mr-1 font-mono text-fg-muted">{e.tool}</span>}
          {entrySummary(e)}
        </div>
        <div role="cell" className="flex min-w-0 flex-wrap items-center gap-1">
          {e.kind === 'tool' && e.tier && <TierBadge tier={e.tier} />}
          {outcome && (
            <Badge tone={outcome.tone} className="max-w-full truncate" title={outcome.text}>
              {outcome.text}
            </Badge>
          )}
          {e.kind === 'llm' && e.unmatched && <Badge tone="warning">no output</Badge>}
        </div>
        {open && (
          <div
            role="cell"
            id={detailId}
            className="col-span-full cursor-auto py-2"
            onKeyDown={(ev) => {
              if (ev.key !== 'Escape') return;
              ev.stopPropagation();
              onToggle(e.id);
              focusRow(index);
            }}
          >
            <AuditEntryDetail entry={e} loadTrace={loadTrace} />
          </div>
        )}
      </div>
    );
  };

  return (
    <div
      role="table"
      aria-label={`Audit log: ${runName}`}
      aria-rowcount={entries.length + 1}
      className="flex min-h-0 flex-1 flex-col rounded-md border border-border bg-surface"
      data-testid="audit-table"
    >
      <div role="rowgroup">
        <div
          role="row"
          aria-rowindex={1}
          className={cx(
            COLS,
            'border-b border-border px-2 py-1 text-micro font-semibold uppercase text-fg-muted',
          )}
        >
          {HEADERS.map((h) => (
            <div role="columnheader" key={h}>
              {h}
            </div>
          ))}
        </div>
      </div>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto" role="rowgroup">
        {virtual ? (
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((v) => (
              <div
                key={v.key}
                data-index={v.index}
                ref={virtualizer.measureElement}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${v.start}px)`,
                }}
              >
                {renderRow(entries[v.index]!, v.index)}
              </div>
            ))}
          </div>
        ) : (
          entries.map((e, i) => <div key={e.id}>{renderRow(e, i)}</div>)
        )}
      </div>
    </div>
  );
}
