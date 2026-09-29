/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * The decision popup wired to a run: decisions are always NOW, so it reads the HEAD (live) projection of the shared
 * run store whatever the scrubber cursor, decides through the normal approval route (optimistic, 409-aware) and
 * takes the viewer's implicit-approval setting (⌘K, default on) and the countdown length (60 s; a mock-mode test hook
 * may shorten it).
 */
import { useCallback, useMemo } from 'react';
import { useRunActions } from '../../app/actions';
import { useServices } from '../../app/services';
import { useLiveMinute } from '../../app/useLiveMinute';
import { useRun } from '../../app/useRunConnection';
import { autoApproveMs } from '../../lib/autoApprove';
import { pendingByUrgency } from '../../lib/derive';
import { usePresenterPace } from '../../lib/presenterPace';
import type { RunStore } from '../../store/runStore';
import { useUi } from '../../store/ui';
import { DecisionPopup } from './DecisionPopup';

export function LiveDecisionPopup({ runId, store }: { runId: string; store: RunStore }) {
  const { mode } = useServices();
  const actions = useRunActions();
  const head = useRun(store, (s) => s.head);
  const cursorSeq = useRun(store, (s) => s.cursorSeq);
  const cursorMinute = useRun(store, (s) => s.view.simMinute);
  const optimistic = useUi((s) => s.optimistic);
  const autoApprove = useUi((s) => s.autoApprove);
  const pending = useMemo(() => pendingByUrgency(head), [head]);
  const nowMinute = useLiveMinute(head, true);
  const ended =
    head.meta.status === 'completed' || head.meta.status === 'failed' || head.meta.status === 'aborted';
  // Presenter pace: a run started fast slows to 6× when the first decision card appears (no-op otherwise).
  const setSpeed = useCallback(
    (speed: number) => actions.control(runId, { action: 'set_speed', speed }, { auto: true }),
    [actions, runId],
  );
  usePresenterPace(
    runId,
    {
      pendingDecisions: pending.length,
      // Before run.created the projection's speed is a placeholder: not a speed change.
      speed: head.meta.mode ? head.meta.speed : undefined,
      enabled: !ended && head.meta.mode === 'agent',
    },
    setSpeed,
  );
  if (ended || head.meta.mode === 'baseline') return null;
  return (
    <DecisionPopup
      pending={pending}
      nowMinute={nowMinute}
      optimistic={optimistic}
      autoApprove={autoApprove}
      durationMs={autoApproveMs(mode)}
      historyMinute={cursorSeq === null ? null : cursorMinute}
      onDecide={(approvalId, req) => actions.decide(runId, approvalId, req)}
    />
  );
}
