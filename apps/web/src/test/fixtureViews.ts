/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** Fixture-driven views for tests and stories: the recordings folded with the shared reducer at chosen points. */
import { foldEvents, type ProjectedApproval, type RunEvent, type RunProjection } from '@ica/schema/browser';
import { RECORDINGS } from '../mocks/recordings';

export const S01 = RECORDINGS[0]!;
export const S04 = RECORDINGS[1]!;

/** Events up to a sim minute (inclusive). */
export function eventsAt(events: RunEvent[], minute: number): RunEvent[] {
  return events.filter((e) => e.simMinute <= minute);
}

export function viewAt(events: RunEvent[], minute: number): { events: RunEvent[]; view: RunProjection } {
  const evs = eventsAt(events, minute);
  return { events: evs, view: foldEvents(evs) };
}

/** The projection just after a proposal was raised (still pending). */
export function pendingApproval(
  events: RunEvent[],
  approvalId: string,
): { view: RunProjection; approval: ProjectedApproval; events: RunEvent[] } {
  const idx = events.findIndex((e) => e.type === 'agent.proposal' && e.payload.approvalId === approvalId);
  if (idx < 0) throw new Error(`no proposal ${approvalId}`);
  const evs = events.slice(0, idx + 1);
  const view = foldEvents(evs);
  return { view, approval: view.approvals[approvalId]!, events: evs };
}
