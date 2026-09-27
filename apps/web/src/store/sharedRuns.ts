/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * One run store per run id, shared by the dashboard and the Agents view (task 08): selecting a row in the Agents
 * view moves the same scrubber the dashboard uses, so going back to the dashboard shows that moment in history
 * mode. The few most recent stores are kept; older ones are dropped (their events are re-fetched on return).
 */
import { useMemo } from 'react';
import { createRunStore, type RunStore } from './runStore';

const KEEP = 4;
const stores = new Map<string, RunStore>();

export function sharedRunStore(runId: string): RunStore {
  let store = stores.get(runId);
  if (store) {
    // Most recently used last.
    stores.delete(runId);
    stores.set(runId, store);
    return store;
  }
  store = createRunStore(runId);
  stores.set(runId, store);
  while (stores.size > KEEP) stores.delete(stores.keys().next().value!);
  return store;
}

/** Test aid. */
export function clearSharedRunStores(): void {
  stores.clear();
}

export function useSharedRunStore(runId: string): RunStore {
  return useMemo(() => sharedRunStore(runId), [runId]);
}
