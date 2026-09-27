/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * The dashboard's decision rail. Decisions are always NOW: `useLiveDecisions` reads the HEAD (live) projection of the
 * shared run store whatever the scrubber cursor (the dashboard and the Agents view share one scrubber, so a viewer in
 * history mode must still see what is waiting on them). In history mode the rail says so calmly.
 */
import type { ApprovalDecisionRequest, ProjectedApproval } from '@ica/schema/browser';
import { useMemo } from 'react';
import { useLiveMinute } from '../../app/useLiveMinute';
import { useRun } from '../../app/useRunConnection';
import { decidedApprovals, openInvalidations, pendingByUrgency } from '../../lib/derive';
import type { RunStore } from '../../store/runStore';
import type { OptimisticDecision } from '../../store/ui';
import { Icon } from '../ui/Icon';
import type { LoadStatus } from '../ui/primitives';
import { DecisionQueue } from './DecisionQueue';

export interface LiveDecisions {
  pending: ProjectedApproval[];
  decided: ProjectedApproval[];
  invalidated: ProjectedApproval[];
  /** The live sim minute (urgency countdowns). */
  liveMinute: number;
  /** The viewed minute when the viewer is in history mode, else null. */
  historyMinute: number | null;
}

export function useLiveDecisions(store: RunStore): LiveDecisions {
  const head = useRun(store, (s) => s.head);
  const cursorSeq = useRun(store, (s) => s.cursorSeq);
  const viewMinute = useRun(store, (s) => s.view.simMinute);
  const pending = useMemo(() => pendingByUrgency(head), [head]);
  const decided = useMemo(() => decidedApprovals(head), [head]);
  const invalidated = useMemo(() => openInvalidations(head), [head]);
  const liveMinute = useLiveMinute(head, true);
  return { pending, decided, invalidated, liveMinute, historyMinute: cursorSeq === null ? null : viewMinute };
}

export function historyNote(minute: number): string {
  return `You’re viewing m${Math.round(minute)} — decisions below are live`;
}

export function DecisionRail({
  decisions,
  optimistic,
  status,
  error,
  onDecide,
}: {
  decisions: LiveDecisions;
  optimistic?: Record<string, OptimisticDecision>;
  status?: LoadStatus;
  error?: string | null;
  onDecide: (approvalId: string, req: ApprovalDecisionRequest) => void;
}) {
  const { pending, decided, invalidated, liveMinute, historyMinute } = decisions;
  return (
    <>
      {historyMinute !== null && status === 'ready' && (
        <p
          data-rail-history-note
          className="mb-2 flex items-center gap-2 rounded-md bg-surface-sunken px-2 py-1 text-caption text-fg-muted"
        >
          <Icon name="clock" size={12} />
          <span>{historyNote(historyMinute)}</span>
        </p>
      )}
      <DecisionQueue
        invalidated={invalidated}
        pending={pending}
        decided={decided}
        nowMinute={liveMinute}
        optimistic={optimistic}
        status={status}
        error={error}
        // The decision popup announces new decisions (one polite announcement, not two).
        announce={false}
        onDecide={onDecide}
      />
    </>
  );
}
