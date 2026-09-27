/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * The Scenario Author, as a banner rather than a column (task 08): shown only if authoring happened. One line
 * ("Scenario enriched from your description" or the fallback notice) that expands to the author's steps.
 */
import { useId, useState } from 'react';
import type { AuthorBanner as AuthorBannerModel } from '../../agents/rows';
import { roleInfo } from '../../agents/roles';
import { Icon } from '../ui/Icon';
import { AiDraftedBadge, cx } from '../ui/primitives';

const STEP_LABEL = { started: 'Started', patched: 'Enriched', fallback: 'Standard scenario used' } as const;

export function AuthorBanner({ author }: { author: AuthorBannerModel }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const preparing = author.status === 'started';
  return (
    <section
      aria-label={roleInfo('author').displayName}
      data-author-banner={author.status}
      className="rounded-md border border-border bg-surface px-3 py-[6px]"
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 text-left text-caption"
      >
        {preparing ? (
          <span
            aria-hidden
            className="inline-block size-3 shrink-0 animate-spin rounded-full border-2 border-border-control border-t-transparent motion-reduce:animate-none"
          />
        ) : (
          <Icon
            name={author.status === 'patched' ? 'check' : 'info'}
            size={12}
            className={author.status === 'patched' ? 'text-good' : 'text-fg-subtle'}
          />
        )}
        <span className="shrink-0 font-semibold text-fg">{roleInfo('author').displayName}</span>
        <span className="min-w-0 flex-1 truncate text-fg-muted" data-author-line>
          {author.line}
        </span>
        {author.status === 'patched' && <AiDraftedBadge />}
        <Icon
          name="chevronDown"
          size={12}
          className={cx('shrink-0 text-fg-subtle transition-transform', open && 'rotate-180')}
        />
      </button>
      {open && (
        <div id={id} className="mt-1 flex flex-col gap-1 border-t border-border pt-1">
          <p className="text-micro text-fg-subtle">{roleInfo('author').objective}</p>
          <ol className="flex flex-col gap-1" aria-label="Scenario Author steps">
            {author.steps.map((s) => (
              <li key={s.seq} className="flex gap-2 text-caption text-fg-muted" data-author-step={s.status}>
                <span className="num shrink-0 text-fg-subtle">m{Math.round(s.minute)}</span>
                <span className="shrink-0 text-fg">{STEP_LABEL[s.status]}</span>
                <span className="min-w-0">{s.detail}</span>
              </li>
            ))}
            {author.rows.map((r) => (
              <li key={r.key} className="flex gap-2 text-caption text-fg-muted" data-author-row={r.kind}>
                <span className="num shrink-0 text-fg-subtle">
                  {r.turn !== undefined ? `T${r.turn} · ` : ''}m{Math.round(r.minute)}
                </span>
                <span className="min-w-0">{r.headline}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}
