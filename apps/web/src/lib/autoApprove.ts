/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Implicit approval — "approve unless objected" (owner decision 2026-09-29; the decision popup's countdown). ON by
 * default: a pending decision is approved IN THE SIGNED-IN PERSON'S NAME after `AUTO_APPROVE_SECONDS` unless they
 * object (engage with the card). It is sent as the normal decision plus `method: 'implicit'`, so the API records
 * the named human with the method, and it reads "Approved by {name} · {role} — no objection within 60 s".
 * A presenter can switch it off in ⌘K. Certifying decisions (`EXPLICIT_ONLY_TOOLS`) never count down.
 */
import {
  IMPLICIT_APPROVAL_SECONDS,
  type ApprovalDecisionRequest,
  type ProjectedApproval,
} from '@ica/schema/browser';

/** The countdown (a constant; the viewer can turn it off in ⌘K, not shorten or lengthen it). */
export const AUTO_APPROVE_SECONDS = IMPLICIT_APPROVAL_SECONDS;
export const AUTO_APPROVE_MS = AUTO_APPROVE_SECONDS * 1_000;

/** The countdown line on the card. */
export function implicitCountdownText(seconds: number): string {
  return `Approving on your behalf in ${seconds}s unless you object`;
}

/** The info tooltip on the countdown, when implicit approval is on (the default; exact copy). */
export const AUTO_APPROVE_EXPLAINER =
  "If you don't object within 60 seconds, this is approved in your name — the way a duty manager's standing approval works in a busy ops room. It's recorded as your implicit approval, so the record is honest about how it was decided.";

/** The info tooltip when it is switched off in ⌘K (exact copy). */
export const AUTO_APPROVE_OFF_EXPLAINER =
  'Decisions wait for you: the agent pauses that action until you approve, edit or reject it. Turn “Approve unless I object” back on in ⌘K and a decision you leave alone for 60 seconds is approved in your name, recorded as your implicit approval.';

/** The info tooltip on a certifying decision (never implicit). */
export const CERTIFYING_EXPLAINER =
  'Airworthiness decisions need an explicit decision from certifying staff, so this one never approves in anyone’s name: it waits until a person decides.';

/** Presenter hint on the card while it waits for the viewer (implicit approval off). Space pauses the world clock. */
export const PAUSE_HINT = 'Press Space to pause the clock while you decide';

export const AUTO_APPROVE_PALETTE_LABEL = 'Approve unless I object (60 s)';

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

/**
 * The request the countdown sends when it runs out: the viewer's own approval (as Duty Manager), marked implicit.
 * `selectedOptionId` overrides the recommended option when the viewer picked one without confirming.
 */
export function autoApproveRequest(
  a: Pick<ProjectedApproval, 'options' | 'args'>,
  selectedOptionId: string | undefined = recommendedOptionId(a),
): ApprovalDecisionRequest {
  return {
    decision: 'approve',
    method: 'implicit',
    roleTitle: 'Duty Manager',
    ...(a.options?.length && selectedOptionId ? { selectedOptionId } : {}),
  };
}
