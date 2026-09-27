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
}

const THEME_KEY = 'ica.theme';
const CAPTIONS_KEY = 'ica.captions';
export const PLAIN_LANGUAGE_KEY = 'ica.plainLanguage';

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
}));
