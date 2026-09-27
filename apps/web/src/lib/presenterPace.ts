/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Presenter pace (demo review 2): "fast until the first decision". With the viewer's toggle on (⌘K or the report
 * dialog; default OFF, persisted per viewer), a run starts at 15× and the UI sets it to 6× through the normal control
 * route when the first decision card appears, with a small toast. A manual speed change by the presenter (palette,
 * speed control, another tab) stops the automatic adjustment for that run.
 *
 * Per-run state lives in this tab's session (a reload keeps it); nothing here is shared with other viewers.
 */
import { useEffect } from 'react';
import { create } from 'zustand';
import { useUi } from '../store/ui';

export const PACE_FAST = 15;
export const PACE_SLOW = 6;
export const PRESENTER_PACE_LABEL = 'Presenter pace: fast until the first decision';
export const PACE_TOAST = `Slowed to ${PACE_SLOW}× — decision needed`;

/** `fast`: waiting for the first decision; `done`: slowed once; `manual`: the presenter took over the speed. */
export type PaceState = 'fast' | 'done' | 'manual';

const SESSION_KEY = 'ica.presenterPace.runs';

function readRuns(): Record<string, PaceState> {
  try {
    const raw = window.sessionStorage.getItem(SESSION_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : {};
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, PaceState>) : {};
  } catch {
    return {};
  }
}

function writeRuns(runs: Record<string, PaceState>): void {
  try {
    window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(runs));
  } catch {
    /* storage blocked: pacing is simply not remembered across a reload */
  }
}

interface PaceStore {
  runs: Record<string, PaceState>;
  /** A run started with presenter pace on. */
  arm(runId: string): void;
  set(runId: string, state: PaceState): void;
}

export const usePace = create<PaceStore>()((set, get) => ({
  runs: readRuns(),
  arm(runId) {
    get().set(runId, 'fast');
  },
  set(runId, state) {
    const runs = { ...get().runs, [runId]: state };
    writeRuns(runs);
    set({ runs });
  },
}));

/** A manual speed change (palette, speed control): stop pacing that run. */
export function markManualSpeed(runId: string): void {
  if (usePace.getState().runs[runId] === 'fast') usePace.getState().set(runId, 'manual');
}

/** The speed a new run starts at: 15× with presenter pace on, else the requested speed. */
export function startSpeed(requested: number, presenterPace = useUi.getState().presenterPace): number {
  return presenterPace ? PACE_FAST : requested;
}

/**
 * Pure step: what to do for a paced run given what the projection shows. `slow` = set 6× now; `manual` = the speed
 * changed without us (another tab, the API): stop pacing; null = nothing.
 */
export function paceStep(
  state: PaceState | undefined,
  input: { pendingDecisions: number; speed: number | undefined },
): 'slow' | 'manual' | null {
  if (state !== 'fast') return null;
  if (input.speed !== undefined && input.speed > 0 && input.speed !== PACE_FAST) return 'manual';
  if (input.pendingDecisions > 0) return 'slow';
  return null;
}

/**
 * Wire a live run to its pacing: when the first decision appears on a run started fast, set 6× via `setSpeed` (the
 * existing control route) and toast. Runs that were not started with presenter pace are untouched.
 */
export function usePresenterPace(
  runId: string,
  input: { pendingDecisions: number; speed: number | undefined; enabled: boolean },
  setSpeed: (speed: number) => void | Promise<void>,
): void {
  const state = usePace((s) => s.runs[runId]);
  const { pendingDecisions, speed, enabled } = input;
  useEffect(() => {
    if (!enabled) return;
    const step = paceStep(state, { pendingDecisions, speed });
    if (step === 'manual') usePace.getState().set(runId, 'manual');
    if (step !== 'slow') return;
    usePace.getState().set(runId, 'done');
    void setSpeed(PACE_SLOW);
    useUi.getState().pushToast({ tone: 'info', title: PACE_TOAST });
  }, [runId, state, pendingDecisions, speed, enabled, setSpeed]);
}
