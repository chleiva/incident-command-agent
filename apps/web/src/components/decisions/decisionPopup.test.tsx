/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Decisions are always NOW (the rail reads the head whatever the cursor) and the gentle decision popup with its
 * implicit-approval countdown ("approve unless objected": ON by default, 60 s, sent as the viewer's own approval with
 * `method: 'implicit'`; it pauses on hover/focus, is cancelled by editing, rejecting or deciding manually, is
 * 409-graceful, and can be switched off in ⌘K). Plus how implicit and simulation decisions read wherever shown.
 */
import type { ApprovalDecisionRequest, ProjectedApproval, RunEvent } from '@ica/schema/browser';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decisionHeadline } from '../../agents/rows';
import { decideOptimistically, type DecideOutcome } from '../../app/actions';
import { ApiRequestError } from '../../lib/api';
import {
  AUTO_APPROVE_EXPLAINER,
  AUTO_APPROVE_MS,
  AUTO_APPROVE_OFF_EXPLAINER,
  AUTO_APPROVE_SECONDS,
  PAUSE_HINT,
  autoApproveMs,
  autoApproveRequest,
} from '../../lib/autoApprove';
import { describeEvent } from '../../lib/describe';
import {
  IMPLICIT_SUFFIX,
  SIMULATION_AUTO_LABEL,
  actorLabel,
  decisionPhrase,
  implicitShortPhrase,
} from '../../lib/format';
import { pendingByUrgency } from '../../lib/derive';
import { createRunStore, type RunStore } from '../../store/runStore';
import { AUTO_APPROVE_KEY, LEGACY_AUTO_APPROVE_KEYS, readAutoApprove, useUi } from '../../store/ui';
import { S01, pendingApproval } from '../../test/fixtureViews';
import { ApproverLine } from '../ui/primitives';
import { DecisionPopup, resetDecisionPopupState, type DecisionPopupProps } from './DecisionPopup';
import { DecisionRail, historyNote, useLiveDecisions } from './DecisionRail';

const SIM = { kind: 'policy', policy: 'simulation-auto' } as const;
const { approval: MSG } = pendingApproval(S01.agent, 'ap-msg-1');

function variant(id: string, minute: number, summary: string): ProjectedApproval {
  return { ...MSG, approvalId: id, createdAtMinute: minute, summary };
}
const QUEUE = [MSG, variant('ap-x-2', 7, 'Second decision'), variant('ap-x-3', 9, 'Third decision')];

function popup(props: Partial<DecisionPopupProps> = {}) {
  const onDecide = vi.fn<(id: string, req: ApprovalDecisionRequest) => Promise<DecideOutcome>>(
    async () => 'ok',
  );
  const utils = render(
    <DecisionPopup pending={QUEUE} nowMinute={6} autoApprove onDecide={onDecide} static {...props} />,
  );
  const card = () => document.querySelector('article[data-popup-approval]') as HTMLElement;
  const wrapper = () => card().parentElement as HTMLElement;
  return {
    ...utils,
    onDecide: props.onDecide ? (props.onDecide as typeof onDecide) : onDecide,
    card,
    wrapper,
  };
}

const tick = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

beforeEach(() => resetDecisionPopupState());
afterEach(() => {
  vi.useRealTimers();
  useUi.setState({ autoApprove: false, optimistic: {} });
});

describe('<DecisionPopup>', () => {
  it('shows one card at a time: summary, the requesting agent, what approving authorises, and the queue', async () => {
    const { card } = popup({ autoApprove: false });
    expect(card()).toHaveAttribute('data-popup-approval', 'ap-msg-1');
    expect(card().textContent).toContain(MSG.summary);
    expect(card().textContent).toContain('Asked by the Passengers agent');
    expect(card().textContent).toContain('Approving authorises');
    expect(card().textContent).toContain('It does not authorise');
    expect(within(card()).getByRole('button', { name: /^Approve/ })).toBeInTheDocument();
    expect(within(card()).getByRole('button', { name: /^Edit/ })).toBeInTheDocument();
    expect(within(card()).getByRole('button', { name: /^Reject/ })).toBeInTheDocument();
    const more = within(card()).getByRole('button', { name: '2 more waiting' });
    await userEvent.click(more);
    const list = within(card()).getByRole('list', { name: 'Also waiting, most urgent first' });
    expect(
      within(list)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Passengers: Second decision', 'Passengers: Third decision']);
    // It never blocks the page: not a dialog, no focus trap.
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it(`approves in the viewer's name after ${AUTO_APPROVE_SECONDS} s unless they object (method implicit)`, () => {
    vi.useFakeTimers();
    const { card, onDecide } = popup();
    expect(AUTO_APPROVE_SECONDS).toBe(60);
    expect(AUTO_APPROVE_MS).toBe(60_000);
    expect(card().textContent).toContain('Approving on your behalf in 60s unless you object');
    expect(card().querySelector('[role="timer"]')).toBeInTheDocument();
    tick(30_000);
    expect(card().textContent).toContain('Approving on your behalf in 30s unless you object');
    expect(onDecide).not.toHaveBeenCalled();
    tick(30_200);
    expect(onDecide).toHaveBeenCalledTimes(1);
    // The normal decision, as the viewer (Duty Manager), marked implicit — never a policy.
    expect(onDecide).toHaveBeenCalledWith('ap-msg-1', {
      decision: 'approve',
      method: 'implicit',
      roleTitle: 'Duty Manager',
    });
    expect(onDecide.mock.calls[0]![1].policy).toBeUndefined();
  });

  it('pauses while hovered (WCAG 2.2.1) and resumes on leave', () => {
    vi.useFakeTimers();
    const { card, wrapper, onDecide } = popup();
    tick(3_000);
    fireEvent.pointerEnter(wrapper());
    tick(120_000);
    expect(onDecide).not.toHaveBeenCalled();
    expect(card().querySelector('[role="timer"]')!.textContent).toBe('Paused while you look · 57s left');
    fireEvent.pointerLeave(wrapper());
    tick(56_000);
    expect(onDecide).not.toHaveBeenCalled();
    tick(1_200);
    expect(onDecide).toHaveBeenCalledTimes(1);
  });

  it('pauses while focused, resumes when focus leaves', () => {
    vi.useFakeTimers();
    const { card, onDecide } = popup();
    act(() => card().focus());
    tick(120_000);
    expect(onDecide).not.toHaveBeenCalled();
    act(() => card().blur());
    tick(60_200);
    expect(onDecide).toHaveBeenCalledTimes(1);
  });

  it('never approves an airworthiness decision implicitly: certifying staff decide explicitly', () => {
    vi.useFakeTimers();
    const eng = { ...MSG, approvalId: 'ap-eng-1', tool: 'record_engineering_decision' };
    const { card, onDecide } = popup({ pending: [eng] });
    expect(card().textContent).toContain(
      'Airworthiness decisions need an explicit decision from certifying staff',
    );
    expect(card().querySelector('[role="timer"]')).toBeNull();
    tick(600_000);
    expect(onDecide).not.toHaveBeenCalled();
    // A person deciding it sends an explicit decision as certifying staff (no method).
    fireEvent.click(within(card()).getByRole('button', { name: /^Approve/ }));
    expect(onDecide).toHaveBeenCalledWith('ap-eng-1', {
      decision: 'approve',
      roleTitle: 'Certifying Engineer (B1)',
    });
  });

  it('never auto-approves when the toggle is off: the card waits indefinitely, with no countdown UI', () => {
    vi.useFakeTimers();
    const { card, onDecide } = popup({ autoApprove: false });
    expect(card().querySelector('[data-countdown-off]')!.textContent).toContain('Waiting for your decision');
    expect(card().querySelector('[role="timer"]')).toBeNull();
    expect(card().querySelector('[data-countdown-ring]')).toBeNull();
    tick(120_000);
    expect(onDecide).not.toHaveBeenCalled();
    expect(card().querySelector('[role="timer"]')).toBeNull();
  });

  it('while it waits (auto-approve off), the presenter hint says Space pauses the clock', () => {
    const { card } = popup({ autoApprove: false });
    expect(card().querySelector('[data-popup-pause-hint]')!.textContent).toBe(PAUSE_HINT);
    expect(PAUSE_HINT).toBe('Press Space to pause the clock while you decide');
  });

  it('no pause hint while the countdown runs (auto-approve on)', () => {
    const { card } = popup();
    expect(card().querySelector('[data-popup-pause-hint]')).toBeNull();
    expect(card().querySelector('[role="timer"]')).not.toBeNull();
  });

  it('switched off: the info tooltip says decisions wait and how to turn it back on', async () => {
    const { card } = popup({ autoApprove: false });
    act(() => within(card()).getByRole('button', { name: 'About approve unless I object' }).focus());
    const tip = (await screen.findByRole('tooltip')).textContent;
    expect(tip).toContain(AUTO_APPROVE_OFF_EXPLAINER);
    expect(AUTO_APPROVE_OFF_EXPLAINER).toContain('⌘K');
    expect(AUTO_APPROVE_OFF_EXPLAINER).toContain('implicit approval');
  });

  it('never auto-approves once the viewer starts editing (the DiffEditor), even after cancelling', () => {
    vi.useFakeTimers();
    const { card, wrapper, onDecide } = popup();
    fireEvent.click(within(card()).getByRole('button', { name: /^Edit/ }));
    fireEvent.pointerLeave(wrapper());
    expect(within(card()).getByText('Edit payload')).toBeInTheDocument();
    tick(90_000);
    fireEvent.click(within(card()).getByRole('button', { name: 'Cancel' }));
    tick(90_000);
    expect(onDecide).not.toHaveBeenCalled();
    expect(card().textContent).toContain('Waiting for your decision');
  });

  it('Reject asks for a reason and never auto-approves meanwhile', async () => {
    const { card, onDecide } = popup();
    await userEvent.click(within(card()).getByRole('button', { name: /^Reject/ }));
    const reject = within(card()).getByRole('button', { name: 'Reject' });
    expect(reject).toBeDisabled();
    await userEvent.type(within(card()).getByLabelText('Reason for rejecting (required)'), 'Wrong cohort');
    await userEvent.click(reject);
    expect(onDecide).toHaveBeenCalledWith('ap-msg-1', {
      decision: 'reject',
      reason: 'Wrong cohort',
      roleTitle: 'Duty Manager',
    });
  });

  it('a manual decision cancels the countdown (one call, as the person) and the next card follows', () => {
    vi.useFakeTimers();
    const { card, onDecide } = popup();
    fireEvent.click(within(card()).getByRole('button', { name: /^Approve/ }));
    expect(onDecide).toHaveBeenCalledWith('ap-msg-1', { decision: 'approve', roleTitle: 'Duty Manager' });
    expect(card()).toHaveAttribute('data-popup-approval', 'ap-x-2');
    tick(2_000);
    expect(onDecide).toHaveBeenCalledTimes(1);
  });

  it('a decision taken elsewhere (optimistic, from the rail) drops the card and its countdown', () => {
    vi.useFakeTimers();
    const { card, rerender, onDecide } = popup();
    tick(4_000);
    rerender(
      <DecisionPopup
        pending={QUEUE}
        nowMinute={6}
        autoApprove
        onDecide={onDecide}
        static
        optimistic={{ 'ap-msg-1': { decision: 'approve', state: 'sending' } }}
      />,
    );
    expect(card()).toHaveAttribute('data-popup-approval', 'ap-x-2');
    tick(55_000);
    expect(onDecide).not.toHaveBeenCalled();
  });

  it('409 (decided elsewhere first) closes the card gracefully', async () => {
    vi.useFakeTimers();
    const onDecide = vi.fn(async (): Promise<DecideOutcome> => 'conflict');
    const { card } = popup({ onDecide, pending: QUEUE.slice(0, 2) });
    tick(60_200);
    await act(async () => {
      await Promise.resolve();
    });
    expect(onDecide).toHaveBeenCalledTimes(1);
    expect(card()).toHaveAttribute('data-popup-approval', 'ap-x-2');
    expect(document.querySelector('[data-decision-popup] [aria-live="polite"]')!.textContent).toContain(
      'already taken elsewhere',
    );
  });

  it('keyboard: D focuses the card; A approves while it has focus', () => {
    const { card, onDecide } = popup({ autoApprove: false });
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0);
      return 0;
    });
    fireEvent.keyDown(document.body, { key: 'd' });
    expect(card()).toHaveFocus();
    fireEvent.keyDown(card(), { key: 'a' });
    expect(onDecide).toHaveBeenCalledWith('ap-msg-1', { decision: 'approve', roleTitle: 'Duty Manager' });
    raf.mockRestore();
  });

  it('announces a new card in a polite live region', () => {
    popup({ autoApprove: false });
    const region = document.querySelector('[data-decision-popup] [aria-live="polite"]')!;
    expect(region.textContent).toContain('Decision needed from the Passengers agent');
    expect(region.textContent).toContain('Press D to review it.');
  });

  it('the info tooltip explains implicit approval in the exact words', async () => {
    const { card } = popup();
    expect(AUTO_APPROVE_EXPLAINER).toBe(
      "If you don't object within 60 seconds, this is approved in your name — the way a duty manager's standing approval works in a busy ops room. It's recorded as your implicit approval, so the record is honest about how it was decided.",
    );
    act(() => within(card()).getByRole('button', { name: 'Why this is approved in your name' }).focus());
    expect((await screen.findByRole('tooltip')).textContent).toContain(AUTO_APPROVE_EXPLAINER);
  });

  it('a decision with options auto-approves the recommended option', () => {
    const options = [
      { id: 'o-a', label: 'Delay', recommended: false },
      { id: 'o-b', label: 'Swap', recommended: true },
    ] as unknown as ProjectedApproval['options'];
    expect(autoApproveRequest({ options, args: {} })).toEqual({
      decision: 'approve',
      method: 'implicit',
      roleTitle: 'Duty Manager',
      selectedOptionId: 'o-b',
    });
    // An option the viewer picked (without confirming) is the one approved.
    expect(autoApproveRequest({ options, args: {} }, 'o-a').selectedOptionId).toBe('o-a');
  });

  it('in history mode, says the card is live', () => {
    popup({ autoApprove: false, historyMinute: 3 });
    expect(document.querySelector('[data-popup-history]')!.textContent).toBe(
      'Live decision — you’re viewing m3',
    );
  });

  it('the countdown length is a constant; only a mock-mode test hook can shorten it', () => {
    const w = window as unknown as Record<string, unknown>;
    w.__ICA_TEST_AUTO_APPROVE_MS__ = 1500;
    expect(autoApproveMs('mock')).toBe(1500);
    expect(autoApproveMs('live')).toBe(AUTO_APPROVE_MS);
    delete w.__ICA_TEST_AUTO_APPROVE_MS__;
    expect(autoApproveMs('mock')).toBe(AUTO_APPROVE_MS);
  });
});

describe('the ⌘K auto-approve setting', () => {
  afterEach(() => window.localStorage.clear());

  it('defaults ON for everyone', () => {
    window.localStorage.clear();
    expect(readAutoApprove()).toBe(true);
  });

  it('migrates once: a preference stored under the v1/v2 keys (on or off) is dropped, so the viewer starts ON', () => {
    expect(AUTO_APPROVE_KEY).toBe('ica.autoApprove.v3');
    expect(LEGACY_AUTO_APPROVE_KEYS).toEqual(['ica.autoApprove', 'ica.autoApprove.v2']);
    for (const key of LEGACY_AUTO_APPROVE_KEYS) {
      for (const legacy of ['on', 'off']) {
        window.localStorage.setItem(key, legacy);
        expect(readAutoApprove()).toBe(true);
        expect(window.localStorage.getItem(key)).toBeNull();
      }
    }
  });

  it('only an explicit ⌘K "off" (v3) turns it off, and it persists', () => {
    useUi.getState().setAutoApprove(false);
    expect(window.localStorage.getItem(AUTO_APPROVE_KEY)).toBe('off');
    expect(readAutoApprove()).toBe(false);
  });

  it('persists per viewer and survives blocked storage', () => {
    useUi.getState().setAutoApprove(false);
    expect(window.localStorage.getItem(AUTO_APPROVE_KEY)).toBe('off');
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => useUi.getState().setAutoApprove(true)).not.toThrow();
    expect(useUi.getState().autoApprove).toBe(true);
    set.mockRestore();
    window.localStorage.removeItem(AUTO_APPROVE_KEY);
  });
});

describe('decisions are always NOW (the rail reads the head)', () => {
  function loaded(): RunStore {
    const { events } = pendingApproval(S01.agent, 'ap-msg-1');
    const store = createRunStore('run-s01');
    store.getState().append(events as RunEvent[]);
    return store;
  }
  function Rail({ store }: { store: RunStore }) {
    const decisions = useLiveDecisions(store);
    return <DecisionRail decisions={decisions} status="ready" onDecide={() => {}} />;
  }

  it('with the cursor in the past and a pending approval at the head, the rail lists it (with a calm note)', () => {
    const store = loaded();
    act(() => store.getState().setCursor(5));
    const { view, head, cursorSeq } = store.getState();
    expect(cursorSeq).toBe(5);
    // The bug: the projection at the cursor has no pending approval yet.
    expect(pendingByUrgency(view)).toEqual([]);
    expect(pendingByUrgency(head).map((a) => a.approvalId)).toEqual(['ap-msg-1']);
    render(<Rail store={store} />);
    expect(document.querySelector('[data-approval="ap-msg-1"]')).toBeInTheDocument();
    expect(document.querySelector('[data-rail-history-note]')!.textContent).toBe(historyNote(view.simMinute));
    expect(historyNote(12.4)).toBe('You’re viewing m12 — decisions below are live');
  });

  it('live: no note', () => {
    render(<Rail store={loaded()} />);
    expect(document.querySelector('[data-approval="ap-msg-1"]')).toBeInTheDocument();
    expect(document.querySelector('[data-rail-history-note]')).toBeNull();
  });
});

describe('"Auto-approved (simulation)" wherever a decision is shown', () => {
  it('labels, phrases, the Agents view decision row and the why-drawer never read as the user', () => {
    expect(actorLabel(SIM)).toBe(SIMULATION_AUTO_LABEL);
    expect(SIMULATION_AUTO_LABEL).toBe('Auto-approved (simulation)');
    expect(decisionPhrase(SIM)).toBe('Auto-approved (simulation)');
    expect(decisionPhrase({ kind: 'human', name: 'Sam', roleTitle: 'Duty Manager' })).toBe(
      'Approved by Sam · Duty Manager',
    );
    expect(decisionHeadline({ approvalId: 'a', decision: 'approve', decidedBy: SIM }, 6.4)).toBe(
      'Auto-approved (simulation) at m6',
    );
    expect(
      decisionHeadline(
        {
          approvalId: 'a',
          decision: 'approve',
          decidedBy: { kind: 'human', name: 'S', roleTitle: 'Duty Manager' },
        },
        6.4,
      ),
    ).toBe('Approved by Duty Manager at m6');
    const e = {
      type: 'approval.decision',
      payload: { approvalId: 'a', decision: 'approve', decidedBy: SIM },
    } as unknown as RunEvent;
    expect(describeEvent(e)).toBe('Auto-approved (simulation)');
    render(<ApproverLine actor={SIM} />);
    expect(document.querySelector('[data-simulation-auto]')!.textContent).toBe('Auto-approved (simulation)');
  });

  it('an implicit approval reads as the named person, with no objection within 60 s', () => {
    const SAM = { kind: 'human', name: 'Sam Okafor', roleTitle: 'Duty Manager' } as const;
    expect(IMPLICIT_SUFFIX).toBe('no objection within 60 s');
    expect(decisionPhrase(SAM, 'Approved', 'implicit')).toBe(
      'Approved by Sam Okafor · Duty Manager — no objection within 60 s',
    );
    expect(decisionPhrase(SAM, 'Approved', 'explicit')).toBe('Approved by Sam Okafor · Duty Manager');
    expect(decisionPhrase(SIM, 'Approved', 'implicit')).toBe('Auto-approved (simulation)');
    expect(implicitShortPhrase(SAM)).toBe('Approved by Sam Okafor (implicit)');
    const headline = decisionHeadline(
      { approvalId: 'a', decision: 'approve', decidedBy: SAM, method: 'implicit' },
      6.4,
    );
    expect(headline).toBe('Approved by Sam Okafor (implicit) at m6');
    expect(headline.length).toBeLessThanOrEqual(60);
    const e = {
      type: 'approval.decision',
      payload: { approvalId: 'a', decision: 'approve', decidedBy: SAM, method: 'implicit' },
    } as unknown as RunEvent;
    expect(describeEvent(e)).toBe('Approved by Sam Okafor (implicit)');
    render(<ApproverLine actor={SAM} method="implicit" />);
    expect(document.querySelector('[data-implicit]')!.parentElement!.textContent).toBe(
      'Approved by Sam Okafor · Duty Manager — no objection within 60 s',
    );
  });

  it('decideOptimistically: a 409 is a calm conflict, not an error', async () => {
    const api = {
      decideApproval: vi.fn(async () => {
        throw new ApiRequestError('approval is approved', 409, 'approval_not_pending');
      }),
    };
    const out = await decideOptimistically(api, 'run-1', 'ap-1', {
      decision: 'approve',
      policy: 'simulation-auto',
    });
    expect(out).toBe('conflict');
    expect(useUi.getState().optimistic['ap-1']).toBeUndefined();
    expect(useUi.getState().toasts.some((t) => t.title === 'Decision not sent')).toBe(false);
  });
});
