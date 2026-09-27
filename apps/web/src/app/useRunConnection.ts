/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** Connects a run store to the API + WebSocket through `RunStream` (spec §4 algorithm), with toasts. */
import { useEffect, useMemo } from 'react';
import { useStore } from 'zustand';
import { RunStream } from '../lib/runStream';
import { createRunStore, type RunState, type RunStore } from '../store/runStore';
import { useUi } from '../store/ui';
import { useServices } from './services';

export function useRunConnection(
  store: RunStore,
  runId: string | null | undefined,
  opts: { toasts?: boolean } = {},
) {
  const services = useServices();
  const toasts = opts.toasts ?? true;
  useEffect(() => {
    if (!runId) return;
    const s = store.getState();
    if (s.runId !== runId) s.reset(runId);
    const ui = useUi.getState();
    const stream = new RunStream({
      runId,
      afterSeq: store.getState().log.lastSeq,
      listEvents: (id, after) => services.api.listEvents(id, after),
      openSocket: () => services.openRunSocket(runId),
      onEvents: (events) => {
        if (events[0]?.seq === 1) useUi.getState().markFirstEvent();
        store.getState().append(events);
      },
      onStatus: (status, prev) => {
        store.getState().setStatus(status);
        if (toasts && status === 'reconnecting' && prev === 'live') {
          ui.pushToast(
            {
              tone: 'warning',
              title: 'Connection lost — reconnecting',
              body: 'Polling for new events every 2 s meanwhile.',
            },
            6_000,
          );
        }
      },
      onReconnected: () =>
        toasts &&
        ui.pushToast({
          tone: 'good',
          title: 'Reconnected',
          body: 'Live updates resumed; no events were missed.',
        }),
      onError: (err) => {
        if (store.getState().log.lastSeq === 0)
          store.getState().setLoadError(err instanceof Error ? err.message : String(err));
      },
    });
    void stream.start();
    return () => stream.stop();
  }, [store, runId, services, toasts]);
}

/** A run store for the lifetime of the component. */
export function useRunStoreInstance(): RunStore {
  return useMemo(() => createRunStore(), []);
}

export function useRun<T>(store: RunStore, selector: (s: RunState) => T): T {
  return useStore(store, selector);
}
