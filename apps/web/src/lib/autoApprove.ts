/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Simulation auto-approval (the decision popup's countdown). OFF by default: a pending decision waits for the
 * viewer. When the viewer turns it on in ⌘K, a pending decision approves itself after `AUTO_APPROVE_SECONDS`
 * unless the viewer engages with it; it is recorded as
 * `{kind:'policy', policy:'simulation-auto'}` and always reads "Auto-approved (simulation)", never as the viewer.
 */
import type { ApprovalDecisionRequest, ProjectedApproval } from '@ica/schema/browser';

/** The countdown (a constant; the viewer can turn auto-approval off in ⌘K, not shorten or lengthen it). */
export const AUTO_APPROVE_SECONDS = 10;
export const AUTO_APPROVE_MS = AUTO_APPROVE_SECONDS * 1_000;

/** The info tooltip on the countdown, when auto-approve is on (exact copy). */
export const AUTO_APPROVE_EXPLAINER =
  'This is a simulation, so decisions approve themselves after 10 seconds to keep the incident moving. In a real operation, the right approver would be paged, the agent would wait for their answer, and it would follow up if nobody responded.';

/** The info tooltip when auto-approve is off (the default; exact copy). */
export const AUTO_APPROVE_OFF_EXPLAINER =
  'Decisions wait for you: the agent pauses that action until you approve, edit or reject it. For a hands-off demo, turn on auto-approve in ⌘K and decisions approve themselves after 10 seconds, always labelled “Auto-approved (simulation)”, never as a person.';

/** Presenter hint on the card while it waits for the viewer (auto-approve off). Space pauses the world clock. */
export const PAUSE_HINT = 'Press Space to pause the clock while you decide';

export const AUTO_APPROVE_PALETTE_LABEL = 'Auto-approve decisions after 10 s';

/** Test-only hook (mock mode only): Playwright sets `window.__ICA_TEST_AUTO_APPROVE_MS__` to shorten the wait. */
const TEST_HOOK = '__ICA_TEST_AUTO_APPROVE_MS__';

export function autoApproveMs(mode: 'mock' | 'live'): number {
  if (mode !== 'mock') return AUTO_APPROVE_MS;
  try {
    const v = (window as unknown as Record<string, unknown>)[TEST_HOOK];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  } catch {
    /* no window */
  }
  return AUTO_APPROVE_MS;
}

/** The option a decision with options would take (recommended, else the first). */
export function recommendedOptionId(a: Pick<ProjectedApproval, 'options' | 'args'>): string | undefined {
  if (!a.options?.length) return undefined;
  const rec = typeof a.args.recommendedOptionId === 'string' ? a.args.recommendedOptionId : undefined;
  return (
    a.options.find((o) => o.recommended)?.id ??
    (rec && a.options.some((o) => o.id === rec) ? rec : undefined) ??
    a.options[0]!.id
  );
}

/** The request the countdown sends when it runs out. */
export function autoApproveRequest(a: Pick<ProjectedApproval, 'options' | 'args'>): ApprovalDecisionRequest {
  const selectedOptionId = recommendedOptionId(a);
  return {
    decision: 'approve',
    policy: 'simulation-auto',
    ...(selectedOptionId ? { selectedOptionId } : {}),
  };
}
