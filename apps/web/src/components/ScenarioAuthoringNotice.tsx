/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Calm notice driven by `scenario.authoring` events (async authoring): while the Run Lambda prepares the scenario
 * from the duty manager's description, then the outcome — enriched, or the standard scenario for the flight. The
 * fallback is informative, never an alarm: the run goes ahead either way.
 */
import type { RunProjection } from '@ica/schema/browser';
import { Icon } from './ui/Icon';
import { AiDraftedBadge, cx } from './ui/primitives';

export function ScenarioAuthoringNotice({
  authoring,
  onDismiss,
}: {
  authoring: NonNullable<RunProjection['meta']['authoring']>;
  onDismiss?: () => void;
}) {
  const preparing = authoring.status === 'started';
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="scenario-authoring"
      data-status={authoring.status}
      className={cx(
        'mx-2 mt-2 flex items-center gap-2 rounded-md border px-3 py-2 text-caption',
        preparing ? 'border-border bg-surface text-fg' : 'border-border bg-surface-sunken text-fg-muted',
      )}
    >
      {preparing ? (
        <span
          aria-hidden
          className="inline-block size-3 shrink-0 animate-spin rounded-full border-2 border-border-control border-t-transparent motion-reduce:animate-none"
        />
      ) : (
        <Icon name={authoring.status === 'patched' ? 'check' : 'info'} size={12} />
      )}
      <span className="min-w-0 flex-1">
        {authoring.detail}
        {preparing && (
          <span className="text-fg-subtle"> The world starts as soon as the scenario is ready.</span>
        )}
      </span>
      {authoring.status === 'patched' && <AiDraftedBadge />}
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
  );
}
