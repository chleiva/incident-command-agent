/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Provenance and scope of a recommendation or decision card (task 06 §1.5): sources (citations with a one-click
 * quote), timestamps (sim time created, data as-of), unresolved checks, and exactly what approving authorises and
 * what it does not. Every field is optional in the contract; a missing one is shown honestly ("not stated").
 */
import type { ApprovalScope, Citation } from '@ica/schema/browser';
import { useId, useState } from 'react';
import { GlossaryText } from '../../glossary/Term';
import { Icon } from '../ui/Icon';
import { cx } from '../ui/primitives';

export function formatSimMinute(m: number | undefined, clock?: (m: number) => string): string {
  if (m === undefined || Number.isNaN(m)) return 'not stated';
  return clock ? `${clock(m)}Z (min ${m.toFixed(1)})` : `min ${m.toFixed(1)}`;
}

/** A citation chip; one click reveals the verbatim quote. */
export function SourceChip({ citation }: { citation: Citation }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <li className="min-w-0">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={`${id}-quote`}
        onClick={() => setOpen(!open)}
        className="inline-flex max-w-full items-center gap-1 rounded-sm border border-border bg-surface-sunken px-1.5 py-0.5 text-micro text-fg-muted hover:text-fg"
        title={`${citation.title} (${citation.sourceId}): show the quote`}
      >
        <Icon name="link" size={10} />
        <span className="truncate">{citation.title}</span>
      </button>
      {open && (
        <blockquote
          id={`${id}-quote`}
          className="mt-1 border-l-2 border-border-control pl-2 text-caption text-fg-muted"
        >
          “{citation.quote}”{' '}
          <a
            href={citation.url}
            target="_blank"
            rel="noreferrer noopener"
            className="font-mono text-micro text-fg-subtle underline"
          >
            {citation.sourceId}
          </a>
        </blockquote>
      )}
    </li>
  );
}

export function ProvenancePanel({
  createdAtMinute,
  dataAsOfMinute,
  citations,
  unresolvedChecks,
  approvalScope,
  clock,
  className,
  title = 'Provenance and scope',
}: {
  createdAtMinute?: number;
  dataAsOfMinute?: number;
  citations?: Citation[];
  unresolvedChecks?: string[];
  approvalScope?: ApprovalScope;
  clock?: (m: number) => string;
  className?: string;
  title?: string;
}) {
  return (
    <section
      aria-label={title}
      data-provenance
      className={cx('flex flex-col gap-1.5 rounded-md bg-surface-sunken p-2 text-caption', className)}
    >
      <div data-part="timestamps" className="flex flex-wrap gap-x-3 gap-y-0.5 text-fg-subtle">
        <span>
          <Icon name="clock" size={10} className="mr-0.5 inline" />
          Created {formatSimMinute(createdAtMinute, clock)}
        </span>
        <span>Data as of {formatSimMinute(dataAsOfMinute, clock)}</span>
      </div>

      <div data-part="sources">
        <h5 className="caps text-fg-subtle">Sources</h5>
        {citations?.length ? (
          <ul className="mt-0.5 flex flex-wrap gap-1">
            {citations.map((c) => (
              <SourceChip key={c.chunkId} citation={c} />
            ))}
          </ul>
        ) : (
          <p className="text-fg-subtle">No sources cited for this card.</p>
        )}
      </div>

      <div data-part="unresolved">
        <h5 className="caps text-fg-subtle">Not yet verified</h5>
        {unresolvedChecks?.length ? (
          <ul className="mt-0.5 flex flex-col gap-0.5">
            {unresolvedChecks.map((c) => (
              <li key={c} className="flex gap-1 text-fg-muted">
                <span aria-hidden className="text-warning">
                  ○
                </span>
                <span>
                  <GlossaryText text={c} />
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-fg-subtle">Not stated.</p>
        )}
      </div>

      <div data-part="scope">
        <h5 className="caps text-fg-subtle">Approving authorises</h5>
        {approvalScope ? (
          <>
            <p className="text-fg">
              <GlossaryText text={approvalScope.authorises} />
            </p>
            {approvalScope.doesNotAuthorise.length > 0 && (
              <>
                <h5 className="caps mt-1 text-fg-subtle">It does not authorise</h5>
                <ul className="flex flex-col gap-0.5">
                  {approvalScope.doesNotAuthorise.map((x) => (
                    <li key={x} className="flex gap-1 text-fg-muted">
                      <Icon name="x" size={10} className="mt-1 shrink-0 text-fg-subtle" />
                      <span>
                        <GlossaryText text={x} />
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        ) : (
          <p className="text-fg-subtle">Scope not stated.</p>
        )}
      </div>
    </section>
  );
}
