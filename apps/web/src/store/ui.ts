/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** Global UI state: theme, captions, toasts, palette, zone focus, optimistic approvals, live announcements. */
import type { ApprovalDecisionKind } from '@ica/schema/browser';
import { create } from 'zustand';

export type Theme = 'dark' | 'light';
export type ToastTone = 'info' | 'good' | 'warning' | 'critical';

export interface Toast {
  id: number;
  tone: ToastTone;
  title: string;
  body?: string;
}

export interface OptimisticDecision {
  decision: ApprovalDecisionKind;
  state: 'sending' | 'error';
  selectedOptionId?: string;
}

interface UiState {
  theme: Theme;
  captions: boolean;
  /** Plain-language mode (task 06 §1.11): glossary terms render their plain replacement. Persisted. */
  plainLanguage: boolean;
  devOverlay: boolean;
  paletteOpen: boolean;
  expandedZone: string | null;
  toasts: Toast[];
  optimistic: Record<string, OptimisticDecision>;
  /** Polite live-region text (new decisions, run ended). */
  announcement: string;
  /** FR-02 measurement: wall time of the last trigger (createRun) and the first-event latency. */
  triggeredAt: number | null;
  firstEventMs: number | null;
  /** Paired baseline runs started from the cockpit (agent run → baseline run). */
  pairs: Record<string, string>;
  /** The run currently open (dashboard or Agents view): the "Agents" nav item opens its Agents view. */
  openRunId: string | null;
  /** Agents view (task 08): hide thought rows. Persisted per viewer. */
  hideThoughts: boolean;
  aboutOpen: boolean;
  /**
   * Simulation: pending decisions approve themselves after a 10 s countdown. Default OFF (the card waits for the
   * viewer); turned on per viewer in ⌘K and persisted under `AUTO_APPROVE_KEY` (v2).
   */
  autoApprove: boolean;
  setAutoApprove(on: boolean): void;
  setTheme(t: Theme): void;
  toggleCaptions(): void;
  setPlainLanguage(on: boolean): void;
  togglePlainLanguage(): void;
  toggleDevOverlay(): void;
  setPaletteOpen(open: boolean): void;
  setExpandedZone(zone: string | null): void;
  pushToast(t: Omit<Toast, 'id'>, ttlMs?: number): void;
  dismissToast(id: number): void;
  setOptimistic(approvalId: string, d: OptimisticDecision | null): void;
  announce(text: string): void;
  markTriggered(): void;
  markFirstEvent(): void;
  setPair(agentRunId: string, baselineRunId: string): void;
  setOpenRunId(runId: string | null): void;
  setHideThoughts(on: boolean): void;
  setAboutOpen(open: boolean): void;
}

const THEME_KEY = 'ica.theme';
const CAPTIONS_KEY = 'ica.captions';
export const PLAIN_LANGUAGE_KEY = 'ica.plainLanguage';
export const HIDE_THOUGHTS_KEY = 'ica.agents.hideThoughts';
/**
 * v2: the default flipped to OFF (demo review). Any preference stored under the v1 key is dropped once, so every
 * viewer starts with auto-approve off; only an explicit ⌘K "on" (written to v2) turns it back on.
 */
export const AUTO_APPROVE_KEY = 'ica.autoApprove.v2';
export const LEGACY_AUTO_APPROVE_KEYS = ['ica.autoApprove'] as const;
const OPEN_RUN_KEY = 'ica.openRun';

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* private mode: ignore */
  }
}
function remove(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* storage blocked: nothing to migrate */
  }
}

/** Auto-approve preference: on only when the viewer turned it on under the v2 key (legacy keys are dropped). */
export function readAutoApprove(): boolean {
  for (const k of LEGACY_AUTO_APPROVE_KEYS) remove(k);
  return read(AUTO_APPROVE_KEY) === 'on';
}

function readSession(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeSession(key: string, value: string | null): void {
  try {
    if (value === null) window.sessionStorage.removeItem(key);
    else window.sessionStorage.setItem(key, value);
  } catch {
    /* storage blocked: the open run is simply not remembered across reloads */
  }
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

let toastId = 0;

export const useUi = create<UiState>()((set, get) => ({
  theme: read(THEME_KEY) === 'light' ? 'light' : 'dark',
  captions: read(CAPTIONS_KEY) !== 'off',
  plainLanguage: read(PLAIN_LANGUAGE_KEY) === 'on',
  devOverlay: false,
  paletteOpen: false,
  expandedZone: null,
  toasts: [],
  optimistic: {},
  announcement: '',
  triggeredAt: null,
  firstEventMs: null,
  pairs: {},
  openRunId: readSession(OPEN_RUN_KEY),
  hideThoughts: read(HIDE_THOUGHTS_KEY) === 'on',
  aboutOpen: false,
  autoApprove: readAutoApprove(),
  setAutoApprove(autoApprove) {
    write(AUTO_APPROVE_KEY, autoApprove ? 'on' : 'off');
    set({ autoApprove });
  },
  setTheme(theme) {
    write(THEME_KEY, theme);
    applyTheme(theme);
    set({ theme });
  },
  toggleCaptions() {
    const captions = !get().captions;
    write(CAPTIONS_KEY, captions ? 'on' : 'off');
    set({ captions });
  },
  setPlainLanguage(plainLanguage) {
    write(PLAIN_LANGUAGE_KEY, plainLanguage ? 'on' : 'off');
    set({ plainLanguage });
  },
  togglePlainLanguage() {
    get().setPlainLanguage(!get().plainLanguage);
  },
  toggleDevOverlay() {
    set({ devOverlay: !get().devOverlay });
  },
  setPaletteOpen(paletteOpen) {
    set({ paletteOpen });
  },
  setExpandedZone(expandedZone) {
    set({ expandedZone });
  },
  pushToast(t, ttlMs = 5_000) {
    const id = ++toastId;
    set({ toasts: [...get().toasts.slice(-3), { ...t, id }] });
    if (ttlMs > 0) setTimeout(() => get().dismissToast(id), ttlMs);
  },
  dismissToast(id) {
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },
  setOptimistic(approvalId, d) {
    const next = { ...get().optimistic };
    if (d) next[approvalId] = d;
    else delete next[approvalId];
    set({ optimistic: next });
  },
  announce(text) {
    // Re-announce identical text by clearing first.
    set({ announcement: '' });
    setTimeout(() => set({ announcement: text }), 30);
  },
  markTriggered() {
    set({ triggeredAt: performance.now(), firstEventMs: null });
  },
  markFirstEvent() {
    const t = get().triggeredAt;
    if (t !== null && get().firstEventMs === null) set({ firstEventMs: Math.round(performance.now() - t) });
  },
  setPair(agentRunId, baselineRunId) {
    set({ pairs: { ...get().pairs, [agentRunId]: baselineRunId } });
  },
  setOpenRunId(openRunId) {
    if (openRunId === get().openRunId) return;
    writeSession(OPEN_RUN_KEY, openRunId);
    set({ openRunId });
  },
  setAboutOpen(aboutOpen) {
    set({ aboutOpen });
  },
  setHideThoughts(hideThoughts) {
    write(HIDE_THOUGHTS_KEY, hideThoughts ? 'on' : 'off');
    set({ hideThoughts });
  },
}));
