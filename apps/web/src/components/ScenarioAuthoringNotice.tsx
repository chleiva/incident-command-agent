/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Calm notice driven by `scenario.authoring` events (async authoring): while the Run Lambda prepares the scenario
 * from the duty manager's description, then the outcome — enriched or written from the description, the standard
 * scenario for the flight (typed incident whose details could not be applied), or, for "Something else", that no
 * scenario could be built (nothing unrelated runs in its place). Never an alarm.
 *
 * Once authored, a short "Scenario from your description" card (trigger, the narrative's opening, affected flights)
 * makes any mismatch with what the duty manager reported visible at once. All of it is AI-drafted, untrusted text.
 */
import type { RunProjection } from '@ica/schema/browser';
import { Icon } from './ui/Icon';
import { AiDraftedBadge, Badge, cx } from './ui/primitives';
import { plainText } from '../lib/announce';

type Authoring = NonNullable<RunProjection['meta']['authoring']>;

export function AuthoredScenarioCard({ summary }: { summary: NonNullable<Authoring['summary']> }) {
  return (
    <section
      aria-label="Scenario from your description"
      data-testid="authored-scenario-card"
      className="mt-2 flex flex-col gap-1 rounded-md border border-border bg-surface px-3 py-2"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-caption font-semibold uppercase tracking-wide text-fg-muted">
          Scenario from your description
        </h3>
        <AiDraftedBadge />
        {summary.network && <Badge icon="plane">network-wide</Badge>}
        <span className="num ml-auto text-caption text-fg-muted" data-testid="authored-flights">
          Affects {summary.affectedFlights} flight{summary.affectedFlights === 1 ? '' : 's'}
        </span>
      </div>
      <p className="text-body text-fg" data-testid="authored-trigger">
        {plainText(summary.trigger)}
      </p>
      <p className="line-clamp-3 text-caption text-fg-muted">{plainText(summary.narrative)}</p>
    </section>
  );
}

export function ScenarioAuthoringNotice({
  authoring,
  onDismiss,
}: {
  authoring: Authoring;
  onDismiss?: () => void;
}) {
  const preparing = authoring.status === 'started';
  const done = authoring.status === 'patched';
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="scenario-authoring"
      data-status={authoring.status}
      className={cx(
        'mx-2 mt-2 rounded-md border px-3 py-2 text-caption',
        preparing || authoring.status === 'failed'
          ? 'border-border bg-surface text-fg'
          : 'border-border bg-surface-sunken text-fg-muted',
      )}
    >
      <div className="flex items-center gap-2">
        {preparing ? (
          <span
            aria-hidden
            className="inline-block size-3 shrink-0 animate-spin rounded-full border-2 border-border-control border-t-transparent motion-reduce:animate-none"
          />
        ) : (
          <Icon name={done ? 'check' : 'info'} size={12} />
        )}
        <span className="min-w-0 flex-1">
          {plainText(authoring.detail)}
          {preparing && (
            <span className="text-fg-subtle"> The world starts as soon as the scenario is ready.</span>
          )}
          {authoring.status === 'failed' && (
            <span className="text-fg-subtle"> Nothing else was run in its place.</span>
          )}
        </span>
        {done && !authoring.summary && <AiDraftedBadge />}
        {!preparing && onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            className="shrink-0 text-micro text-fg-subtle underline underline-offset-2 hover:text-fg"
          >
            Dismiss
          </button>
        )}
      </div>
      {done && authoring.summary && <AuthoredScenarioCard summary={authoring.summary} />}
    </div>
  );
}
