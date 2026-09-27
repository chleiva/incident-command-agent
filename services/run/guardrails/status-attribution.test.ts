/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Live run 2 (medical diversion ACX170, AX-NNH): the status-claim screen blocked a maintenance report that QUOTED
 * system state and deferred to certifying staff. Only the agent's own assertion of a status is a claim.
 */
import { describe, expect, it } from 'vitest';
import { screenOutput, screenStatusClaims } from './screen-output';

/** The exact sentences from the blocked report (must pass). */
const LIVE_RUN_2_SENTENCES = [
  'Aircraft status flag in M&E currently shows "unserviceable" pending review',
  "the tail's status in the rotation feed is flagged 'unserviceable'",
  "cannot be assumed airworthy … without certifying staff inspecting and releasing it — that determination is outside this agent's authority",
];

const ATTRIBUTED = [
  ...LIVE_RUN_2_SENTENCES,
  'AX-NNH cannot be assumed airworthy for the next sector without certifying staff inspecting and releasing it.',
  'M&E shows AX-NNH as AOG pending review.',
  'Aircraft status flag in M&E currently shows AOG pending review.',
  'The tail is flagged AOG in the rotation feed.',
  'M&E records the aircraft as AOG.',
  'The rotation feed lists AX-NNH as AOG until certifying staff review it.',
  'Whether the defect is deferrable is for certifying staff to decide.',
  'The aircraft has not been declared AOG.',
  'The aircraft cannot be considered fit to fly until certifying staff release it.',
  'Deferral requires certifying staff; nothing here is a status.',
  'Certifying B1 engineer to determine, after physical inspection, whether this is rectify, defer under an as-yet-unidentified MEL item, or AOG.',
];

const ASSERTIONS = [
  'The aircraft is AOG.',
  'This defect is non-deferrable.',
  'Aircraft is airworthy.',
  'The aircraft is fit to fly.',
  'The aircraft is not airworthy.',
  'AX-NNH is AOG and M&E shows it unserviceable.',
  'M&E shows a nose gear defect, and the aircraft is AOG.',
  'Nose gear damage, deferrable per MEL.',
  'Aircraft AOG awaiting parts.',
  'Declared airworthy by the crew.',
  'The defect can be deferred under the MEL.',
  'The aircraft is now releasable.',
  'Aircraft AOG, check whether parts are available.',
  'The aircraft is AOG and certifying staff will determine the repair.',
];

describe('status-claim screen: attributed system state vs the agent’s own assertion', () => {
  it.each(ATTRIBUTED)('passes attributed/deferred state: %s', (text) => {
    expect(screenStatusClaims(text)).toEqual([]);
  });

  it.each(ASSERTIONS)('still catches an assertion: %s', (text) => {
    expect(screenStatusClaims(text).length).toBeGreaterThan(0);
  });

  it('the full live-run-2 report text passes as a whole', () => {
    const text = `${LIVE_RUN_2_SENTENCES[0]}. On the ground at NTE, ${LIVE_RUN_2_SENTENCES[1]}; AX-NNH ${LIVE_RUN_2_SENTENCES[2]}.`;
    expect(screenStatusClaims(text)).toEqual([]);
  });

  it('an assertion later in a text with an attributed quote is still caught', () => {
    const text = 'M&E shows AX-NNH as AOG pending review. The aircraft is airworthy.';
    expect(screenStatusClaims(text).map((f) => f.pattern)).toEqual(['status:airworthy']);
  });

  it('tech-log drafts stay blocking for assertions', () => {
    expect(screenOutput('techlog', 'Aircraft AOG awaiting parts.').ok).toBe(false);
    expect(
      screenOutput('techlog', 'M&E shows AX-NNH as AOG; inspection by certifying staff pending.').ok,
    ).toBe(true);
  });
});
