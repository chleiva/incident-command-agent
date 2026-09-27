/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Demo review 2: live regions read raw text ("Request decision is reserved for humans; nothing changed", a JSON
 * `send_passenger_message {…}`). Every announcement, caption and toast is plain words: no `_` tool names, no `{`.
 */
import type { ProjectedApproval, RunEvent } from '@ica/schema/browser';
import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetDecisionPopupState, DecisionPopup } from '../components/decisions/DecisionPopup';
import { DecisionQueue } from '../components/decisions/DecisionQueue';
import { LiveAnnouncer, Toasts } from '../components/ui/Toasts';
import { useUi } from '../store/ui';
import { S01, pendingApproval } from '../test/fixtureViews';
import { approvalPhrase, blockedPhrase, looksRaw, plainText } from './announce';
import { captionFor } from './narrator';

const RAW_TOOL = /\b[a-z]+_[a-z_]+\b/;
const clean = (text: string | null | undefined) => {
  expect(text ?? '', text ?? '').not.toMatch(RAW_TOOL);
  expect(text ?? '', text ?? '').not.toContain('{');
};

/** The live shape: the backend summary of a domain proposal is `${tool} ${JSON args}`. */
const RAW_SUMMARY =
  'send_passenger_message {"requestId":"781c0156-0000-4000-8000-000000000010","messageId":"MSG-001-epj","channel":"sms"}';
const { approval: MSG } = pendingApproval(S01.agent, 'ap-msg-1');
const RAW: ProjectedApproval = { ...MSG, tool: 'send_passenger_message', summary: RAW_SUMMARY };

afterEach(() => {
  vi.useRealTimers();
  useUi.setState({ announcement: '', toasts: [] });
});

describe('plain-language announcements', () => {
  it('plainText: tool names become labels, snake_case becomes words, JSON is dropped', () => {
    expect(plainText(RAW_SUMMARY)).toBe('send a passenger message');
    expect(plainText('Request decision is reserved; request_decision failed {"a":1}')).toBe(
      'Request decision is reserved; choose between options failed',
    );
    expect(plainText('Run ended: horizon_reached.')).toBe('Run ended: horizon reached.');
    expect(plainText('Stand [12] stays')).toBe('Stand [12] stays');
    expect(looksRaw(RAW_SUMMARY)).toBe(true);
    expect(looksRaw('Rectify on AX-FXA or swap to AX-FXB?')).toBe(false);
  });

  it('approvalPhrase: the question, or the proposed action in words', () => {
    expect(approvalPhrase(RAW)).toBe(
      approvalPhrase({ tool: 'send_passenger_message', args: RAW.args, summary: '' }),
    );
    clean(approvalPhrase(RAW));
    expect(approvalPhrase(RAW)).toMatch(/passenger message/i);
    expect(
      approvalPhrase({
        tool: 'request_decision',
        args: { question: 'Swap to AX-SAA or wait?' },
        summary: 'request_decision {}',
      }),
    ).toBe('Swap to AX-SAA or wait?');
  });

  it('blockedPhrase: only the tier gate is "only a person may"; a malformed call is sent back', () => {
    expect(blockedPhrase('defer_defect', 'tier')).toBe(
      'Blocked — only a person may defer a defect; nothing changed',
    );
    const bad = blockedPhrase('request_decision', 'arg_validation');
    expect(bad).toBe('Sent back to the agent to fix: choose between options; nothing changed');
    expect(bad).not.toMatch(/reserved for humans/);
    for (const layer of ['tier', 'arg_validation', 'ref_validation', 'output_screen', 'other'])
      clean(blockedPhrase('send_passenger_message', layer));
  });

  it('narrator captions over the recorded runs never carry a tool name or JSON', () => {
    const events: RunEvent[] = [...S01.agent, ...S01.baseline];
    let n = 0;
    for (const e of events) {
      const c = captionFor(e);
      if (c === null) continue;
      clean(c);
      n++;
    }
    expect(n).toBeGreaterThan(10);
    // The live case: a request_decision refused by arg validation, and a raw proposal summary.
    const blocked = {
      ...S01.agent.find((e) => e.type === 'guardrail.blocked')!,
      payload: { layer: 'arg_validation', tool: 'request_decision', reason: 'x' },
    } as RunEvent;
    expect(captionFor(blocked)).toBe(
      'Sent back to the agent to fix: choose between options; nothing changed',
    );
    const proposal = {
      ...S01.agent.find((e) => e.type === 'agent.proposal')!,
    } as RunEvent<'agent.proposal'>;
    const raw = {
      ...proposal,
      payload: { ...proposal.payload, tool: 'send_passenger_message', summary: RAW_SUMMARY },
    };
    clean(captionFor(raw));
  });

  it('the decision popup live region reads the action in words', () => {
    resetDecisionPopupState();
    render(
      <DecisionPopup pending={[RAW]} nowMinute={6} autoApprove={false} onDecide={async () => 'ok'} static />,
    );
    const region = document.querySelector('[data-decision-popup] [aria-live="polite"]')!;
    expect(region.textContent).toMatch(/^Decision needed from the Passengers agent: /);
    clean(region.textContent);
    // The visible card too.
    clean(document.querySelector('article[data-popup-approval]')!.textContent?.replace(/\bAX-\w+/g, ''));
  });

  it('the decision queue announcement, the global announcer and toasts are plain', () => {
    vi.useFakeTimers();
    const { rerender } = render(
      <>
        <DecisionQueue pending={[]} decided={[]} nowMinute={6} onDecide={() => undefined} announce />
        <LiveAnnouncer />
        <Toasts />
      </>,
    );
    rerender(
      <>
        <DecisionQueue pending={[RAW]} decided={[]} nowMinute={6} onDecide={() => undefined} announce />
        <LiveAnnouncer />
        <Toasts />
      </>,
    );
    act(() => void vi.advanceTimersByTime(50));
    const announced = useUi.getState().announcement;
    expect(announced).toMatch(/^Decision needed: /);
    clean(announced);
    act(() => {
      useUi.getState().announce('Run ended: horizon_reached. request_decision {"x":1}');
      useUi.getState().pushToast({
        tone: 'critical',
        title: 'Control command failed',
        body: 'set_speed {"speed":6} rejected',
      });
    });
    act(() => void vi.advanceTimersByTime(50));
    clean(useUi.getState().announcement);
    for (const t of useUi.getState().toasts) {
      clean(t.title);
      clean(t.body);
    }
  });
});
