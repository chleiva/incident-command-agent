/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * A cockpit zone: one question per glance (spec §4). The header names the zone and the question it answers;
 * `F` (or the expand button) takes the focused zone full screen, `Esc` returns.
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { useUi } from '../../store/ui';
import { Icon } from './Icon';
import { cx } from './primitives';

export function Zone({
  id,
  title,
  question,
  actions,
  children,
  className,
  bodyClassName,
  expandable = true,
}: {
  id: string;
  title: string;
  question?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  expandable?: boolean;
}) {
  const expanded = useUi((s) => s.expandedZone === id);
  const setExpanded = useUi((s) => s.setExpandedZone);
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!expanded) return;
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setExpanded(null);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, [expanded, setExpanded]);

  return (
    <section
      ref={ref}
      id={`zone-${id}`}
      data-zone={id}
      aria-labelledby={`zone-${id}-title`}
      tabIndex={-1}
      className={cx(
        'flex min-h-0 min-w-0 flex-col rounded-lg border border-border bg-surface shadow-e1 outline-none',
        expanded && 'fixed inset-4 z-40 shadow-e3',
        className,
      )}
    >
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
        <h2 id={`zone-${id}-title`} className="caps text-fg-muted">
          {title}
        </h2>
        {question && (
          <span className="hidden truncate text-caption text-fg-subtle xl:inline">{question}</span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {actions}
          {expandable && (
            <button
              type="button"
              onClick={() => setExpanded(expanded ? null : id)}
              aria-label={expanded ? `Exit full screen (${title})` : `Full screen (${title})`}
              title={expanded ? 'Exit full screen (Esc)' : 'Full screen (F)'}
              className="inline-flex h-6 w-6 items-center justify-center rounded-sm text-fg-subtle hover:bg-surface-hover hover:text-fg"
            >
              <Icon name={expanded ? 'collapse' : 'expand'} size={13} />
            </button>
          )}
        </div>
      </header>
      <div className={cx('relative min-h-0 flex-1', bodyClassName)}>{children}</div>
    </section>
  );
}
