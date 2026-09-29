/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Calm run-health banners under the header: a final failure ("This run stopped because of a system error: …",
 * technical message expandable, "Start again"), a self-recovery in progress ("Recovering from a system error…"),
 * and a completed recovery ("Recovered — resumed at m{t}", dismissible). A recovery is never shown as a failure.
 * A continuation in a fresh worker (15-min compute limit) is a small informational note that dismisses itself.
 */
import { useEffect } from 'react';
import {
  continuationText,
  type ContinuationNote,
  type RecoveryState,
  type RunFailure,
} from '../lib/runHealth';
import { Icon } from './ui/Icon';
import { Button, cx } from './ui/primitives';

export function RunFailedBanner({
  failure,
  onRestart,
  restartDisabled = false,
  compact = false,
}: {
  failure: RunFailure;
  /** "Start again": a new run of the same scenario. Omitted = no action (e.g. read-only views). */
  onRestart?: () => void;
  restartDisabled?: boolean;
  /** The Agents view header notice: one line, details still expandable. */
  compact?: boolean;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="run-failed"
      className={cx(
        'flex items-start gap-2 rounded-md border border-critical/40 bg-surface text-caption text-fg',
        compact ? 'px-3 py-1.5' : 'mx-2 mt-2 px-3 py-2',
      )}
    >
      <Icon name="alert" size={14} className="mt-0.5 shrink-0 text-critical" />
      <div className="min-w-0 flex-1">
        <p>
          This run stopped because of a system error: <span data-failure-plain>{failure.plain}</span>.
          {failure.minute !== null && (
            <span className="num text-fg-subtle"> Stopped at m{Math.round(failure.minute)}.</span>
          )}
          {!compact && (
            <span className="text-fg-muted">
              {' '}
              Everything up to that moment is kept: scrub the timeline or open the audit log.
            </span>
          )}
        </p>
        <details className="mt-1">
          <summary className="cursor-pointer text-micro text-fg-subtle hover:text-fg">
            Technical details
          </summary>
          <p className="mt-1 break-words font-mono text-micro text-fg-muted" data-failure-technical>
            {failure.where}: {failure.error}
          </p>
        </details>
      </div>
      {onRestart && (
        <Button size="sm" icon="play" onClick={onRestart} disabled={restartDisabled}>
          Start again
        </Button>
      )}
    </div>
  );
}

export function RunRecoveryBanner({
  recovery,
  onDismiss,
  compact = false,
}: {
  recovery: RecoveryState;
  onDismiss?: () => void;
  /** The Agents view: no outer margin. */
  compact?: boolean;
}) {
  const recovering = recovery.status === 'recovering';
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="run-recovery"
      data-status={recovery.status}
      className={cx(
        'flex items-center gap-2 rounded-md border border-border bg-surface text-caption text-fg',
        compact ? 'px-3 py-1.5' : 'mx-2 mt-2 px-3 py-2',
      )}
    >
      {recovering ? (
        <span
          aria-hidden
          className="inline-block size-3 shrink-0 animate-spin rounded-full border-2 border-border-control border-t-transparent motion-reduce:animate-none"
        />
      ) : (
        <Icon name="check" size={12} className="shrink-0 text-good" />
      )}
      <span className="min-w-0 flex-1">
        {recovering ? (
          <>
            Recovering from a system error…
            <span className="text-fg-muted">
              {' '}
              {recovery.plain ? `Cause: ${recovery.plain}. ` : ''}The agents pick up from the record
              {recovery.attempt !== null ? ` (attempt ${recovery.attempt})` : ''}.
            </span>
          </>
        ) : (
          <>
            Recovered — resumed at m{Math.round(recovery.resumedMinute ?? 0)}.
            <span className="text-fg-muted"> The agents were re-briefed from the record.</span>
          </>
        )}
      </span>
      {!recovering && onDismiss && (
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

/** Default time the continuation note stays up. */
export const CONTINUATION_NOTE_MS = 8_000;

/**
 * "Continued in a fresh worker at m{t}": calm and informational (never an error). One worker may run for 15 minutes,
 * so a long, human-paced run carries on in a fresh one with everything kept. Dismisses itself.
 */
export function RunContinuationNote({
  continuation,
  onDismiss,
  autoDismissMs = CONTINUATION_NOTE_MS,
}: {
  continuation: ContinuationNote;
  onDismiss?: () => void;
  /** 0 = stays until dismissed (stories). */
  autoDismissMs?: number;
}) {
  useEffect(() => {
    if (!onDismiss || autoDismissMs <= 0) return;
    const t = setTimeout(onDismiss, autoDismissMs);
    return () => clearTimeout(t);
  }, [onDismiss, autoDismissMs, continuation.seq]);
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="run-continuation"
      className="mx-2 mt-2 flex w-fit max-w-[calc(100%-16px)] items-center gap-2 rounded-md border border-border bg-surface px-3 py-1.5 text-caption text-fg-muted"
    >
      <Icon name="info" size={12} className="shrink-0 text-fg-subtle" />
      <span className="min-w-0">
        <span className="text-fg">{continuationText(continuation)}.</span> The run keeps going: approvals, the
        clock and the speed are unchanged.
      </span>
      {onDismiss && (
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
