/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * One row of an agent column (task 08): turn tag, sim time, type icon, plain-language headline and tier badge.
 * Waiting, decision, invalidation and stop rows have their own icon and colour. The row toggles its detail in place
 * (one open row per column) and, when selected, moves the shared scrubber to its moment.
 */
import { forwardRef, type KeyboardEvent, type ReactNode } from 'react';
import type { AgentRow, RowKind } from '../../agents/rows';
import { roleName } from '../../agents/roles';
import { Icon, type IconName } from '../ui/Icon';
import { Badge, cx, type Tone } from '../ui/primitives';

export const ROW_KIND_LABEL: Record<RowKind, string> = {
  brief: 'Brief',
  thought: 'Thought',
  tool: 'Tool call',
  proposal: 'Proposal',
  waiting: 'Waiting',
  decision: 'Decision',
  invalidated: 'Approval withdrawn',
  blocked: 'Blocked',
  stopped: 'Stopped',
  report: 'Report',
};

export function rowIcon(row: AgentRow): { name: IconName; tone: string } {
  switch (row.kind) {
    case 'brief':
      return { name: row.link ? 'arrowLeft' : 'play', tone: 'text-fg-subtle' };
    case 'thought':
      return { name: 'thought', tone: 'text-ai' };
    case 'tool':
      return row.call?.tool === 'delegate'
        ? { name: 'arrowRight', tone: 'text-fg-muted' }
        : { name: 'wrench', tone: 'text-fg-muted' };
    case 'proposal':
      return { name: 'edit', tone: 'text-warning' };
    case 'waiting':
      return { name: 'hourglass', tone: 'text-warning' };
    case 'decision':
      return {
        name: 'decision',
        tone: row.decision?.decision === 'reject' ? 'text-critical' : 'text-good',
      };
    case 'invalidated':
      return { name: 'undo', tone: 'text-warning' };
    case 'blocked':
      return { name: 'shield', tone: 'text-critical' };
    case 'stopped':
      return { name: 'stop', tone: 'text-critical' };
    case 'report':
      return { name: 'check', tone: 'text-good' };
  }
}

function tierBadge(row: AgentRow): { tone: Tone; text: string } | null {
  if (row.kind === 'decision') {
    const d = row.decision?.decision;
    return d === 'reject'
      ? { tone: 'critical', text: 'Rejected' }
      : { tone: 'good', text: d === 'edit' ? 'Edited' : 'Approved' };
  }
  if (row.tier === 'blocked') return { tone: 'critical', text: 'Blocked' };
  if (row.tier === 'proposed') return { tone: 'warning', text: 'Proposed' };
  if (row.tier === 'executed') return { tone: 'neutral', text: 'Executed' };
  return null;
}

const FRAME: Partial<Record<RowKind, string>> = {
  waiting: 'border-warning/60 bg-warning-bg',
  decision: 'border-good/50 bg-good-bg',
  invalidated: 'border-warning/60 bg-warning-bg',
  blocked: 'border-critical/50 bg-critical-bg',
  stopped: 'border-critical/60 bg-critical-bg',
};

export interface AgentRowViewProps {
  row: AgentRow;
  expanded: boolean;
  focused: boolean;
  highlighted?: boolean;
  /** The row is after the moment the scrubber shows (history mode). */
  future?: boolean;
  detailId: string;
  onToggle: () => void;
  onFocus: () => void;
  onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => void;
  onFollowLink?: () => void;
  /** Link to the dashboard's decision rail for a pending approval. */
  decisionHref?: string;
  onOpenDecisions?: () => void;
  children?: ReactNode;
}

export const AgentRowView = forwardRef<HTMLButtonElement, AgentRowViewProps>(function AgentRowView(
  {
    row,
    expanded,
    focused,
    highlighted,
    future,
    detailId,
    onToggle,
    onFocus,
    onKeyDown,
    onFollowLink,
    decisionHref,
    onOpenDecisions,
    children,
  },
  ref,
) {
  const icon = rowIcon(row);
  const badge = tierBadge(row);
  const live = row.kind === 'waiting' && row.pending;
  const isThought = row.kind === 'thought';
  const linkLabel = row.link
    ? row.link.direction === 'out'
      ? `Go to ${roleName(row.link.role)}'s brief`
      : `Go to the ${roleName(row.link.role)} delegation`
    : '';
  const linkText = row.link?.direction === 'out' ? 'Go to brief' : 'Go to delegation';
  return (
    <div
      data-row={row.key}
      data-kind={row.kind}
      data-seq={row.seq}
      data-pending={live || undefined}
      data-highlighted={highlighted || undefined}
      data-future={future || undefined}
      className={cx(
        'rounded-md border transition-shadow',
        (row.kind === 'waiting' && !live ? undefined : FRAME[row.kind]) ?? 'border-border bg-surface-raised',
        highlighted && 'ring-2 ring-focus',
        // After the viewed moment (history mode): dashed, muted, still readable (AA contrast).
        future && 'border-dashed',
      )}
    >
      <button
        ref={ref}
        type="button"
        tabIndex={focused ? 0 : -1}
        aria-expanded={expanded}
        aria-controls={expanded ? detailId : undefined}
        aria-label={`${row.turn ? `Turn ${row.turn}, ` : ''}minute ${Math.round(row.minute)}, ${ROW_KIND_LABEL[row.kind]}: ${row.headline}${badge ? `, ${badge.text}` : ''}`}
        data-row-button
        onClick={onToggle}
        onFocus={onFocus}
        onKeyDown={onKeyDown}
        className="flex w-full items-start gap-2 rounded-md px-2 py-[6px] text-left outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        <Icon name={icon.name} size={14} className={cx('mt-0.5 shrink-0', icon.tone)} />
        <span className="min-w-0 flex-1">
          <span className="num flex min-h-5 items-center gap-[6px] text-micro text-fg-subtle">
            {row.turn !== undefined && (
              <span className="rounded-sm bg-surface-sunken px-1 font-mono text-fg-muted" data-turn>
                T{row.turn}
              </span>
            )}
            <span data-minute>m{Math.round(row.minute)}</span>
            {row.kind === 'waiting' && !live && row.decision && (
              <span data-waited>waited {Math.max(0, Math.round(row.decision.minute - row.minute))} min</span>
            )}
            {live && (
              <span className="inline-flex items-center gap-1 font-medium text-warning">
                <span className="h-[6px] w-[6px] animate-soft-pulse rounded-full bg-warning" aria-hidden />
                pending
              </span>
            )}
            <span className="ml-auto flex items-center gap-1">
              {badge && <Badge tone={badge.tone}>{badge.text}</Badge>}
              <Icon
                name="chevronDown"
                size={12}
                className={cx('shrink-0 text-fg-subtle transition-transform', expanded && 'rotate-180')}
              />
            </span>
          </span>
          <span
            data-headline
            className={cx('line-clamp-2 text-body', isThought || future ? 'text-fg-muted' : 'text-fg')}
          >
            {row.headline}
          </span>
        </span>
      </button>
      {live && row.proposal && (
        <div className="flex flex-col gap-1 px-2 pb-2 pl-8 text-caption text-fg-muted" data-waiting-live>
          {row.proposal.approvalScope && <span>Scope: {row.proposal.approvalScope.authorises}</span>}
          {(decisionHref || onOpenDecisions) && (
            <a
              href={decisionHref}
              onClick={(e) => {
                if (!onOpenDecisions) return;
                e.preventDefault();
                onOpenDecisions();
              }}
              tabIndex={focused ? 0 : -1}
              className="inline-flex min-h-6 w-fit items-center gap-1 text-fg underline decoration-border-control underline-offset-2 hover:decoration-fg"
            >
              Decide in the decision rail <Icon name="arrowRight" size={11} />
            </a>
          )}
        </div>
      )}
      {row.link && onFollowLink && (
        <div className="-mt-2 px-2 pb-1 pl-8">
          <button
            type="button"
            data-link={row.link.direction}
            aria-label={linkLabel}
            title={linkLabel}
            tabIndex={focused ? 0 : -1}
            onClick={onFollowLink}
            className="inline-flex min-h-6 items-center gap-1 rounded-sm pr-1 text-micro text-fg-muted underline decoration-border-control underline-offset-2 hover:text-fg"
          >
            <Icon name={row.link.direction === 'out' ? 'arrowRight' : 'arrowLeft'} size={10} />
            {linkText}
          </button>
        </div>
      )}
      {expanded && children}
    </div>
  );
});
