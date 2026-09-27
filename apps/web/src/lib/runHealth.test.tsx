/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Run health (demo review): failed runs are visible and calm (cockpit banner, Agents view notice, Audit status), a
 * stopped or aborted run never reads "completed", and self-recovery (additive events) is told apart from a final
 * failure. Plus the Space-pauses-the-clock rule the decision card's presenter hint relies on.
 */
import { emptyProjection, foldEvents, type RunEvent } from '@ica/schema/browser';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { spaceTogglesClock } from '../app/useSpaceToggle';
import { RunStatusBadge } from '../components/audit/AuditView';
import { RunStatusCell } from '../components/audit/RunPicker';
import { RunFailedBanner, RunRecoveryBanner } from '../components/RunHealthBanner';
import { RunEndedCard } from '../components/RunEndedCard';
import { S01 } from '../test/fixtureViews';
import { eventMarkers } from './derive';
import {
  plainFailureReason,
  recoveryEvents,
  recoveryState,
  runFailure,
  runLevelEvents,
  runOutcome,
} from './runHealth';

let seq = 0;
function ev(type: string, payload: Record<string, unknown>, minute: number, extra: object = {}): RunEvent {
  seq += 1;
  return {
    runId: 'run-h',
    seq,
    type,
    actor: { kind: 'system' },
    simMinute: minute,
    simTime: new Date(Date.UTC(2026, 8, 27, 9, minute)).toISOString(),
    wallTime: new Date(Date.UTC(2026, 8, 27, 9, 0, seq)).toISOString(),
    payload,
    ...extra,
  } as unknown as RunEvent;
}

/** S01 cut at minute 20, then the given tail events (seq continues). */
function withTail(build: (base: number) => RunEvent[]): RunEvent[] {
  const head = S01.agent.filter((e) => e.simMinute <= 20);
  seq = head.at(-1)!.seq;
  return [...head, ...build(seq)];
}

describe('plain failure reasons', () => {
  it('turns technical messages into calm, plain words', () => {
    expect(plainFailureReason('Lambda wall clock: 14 min timeout reached', 'runtime')).toBe(
      'the run took longer than the system allows',
    );
    expect(plainFailureReason('anthropic 529 overloaded_error', 'llm')).toBe(
      'the AI service was too busy to answer',
    );
    expect(plainFailureReason('ConditionalCheckFailedException', 'store')).toBe(
      'the event store could not record a step',
    );
    expect(plainFailureReason('fetch failed: ECONNRESET', 'llm')).toBe(
      'a connection to a backend service dropped',
    );
    expect(plainFailureReason('invalid x-api-key (401)', 'llm')).toBe(
      'the AI service rejected the credentials',
    );
    expect(plainFailureReason('TypeError: cannot read properties of undefined', 'runtime')).toBe(
      'an unexpected internal error',
    );
    expect(plainFailureReason(undefined)).toBe('an unexpected internal error');
  });
});

describe('runOutcome: stopped, aborted and failed never read as completed', () => {
  it('maps status + reason to a label and tone', () => {
    expect(runOutcome({ status: 'completed', completedReason: 'report' })).toMatchObject({
      kind: 'completed',
      label: 'completed',
    });
    expect(runOutcome({ status: 'completed', completedReason: 'stopped' })).toMatchObject({
      kind: 'stopped',
      label: 'stopped',
      tone: 'warning',
    });
    expect(runOutcome({ status: 'aborted' })).toMatchObject({ kind: 'aborted', tone: 'warning' });
    expect(runOutcome({ status: 'failed' })).toMatchObject({ kind: 'failed', tone: 'critical' });
    expect(runOutcome({ status: 'error' })).toMatchObject({ kind: 'failed' });
    expect(runOutcome({ status: 'running' })).toMatchObject({ kind: 'active', label: 'running' });
  });
});

describe('a failed run', () => {
  const events = withTail(() => [
    ev('run.failed', { error: 'anthropic 529 overloaded_error after 3 retries', where: 'llm' }, 21),
  ]);
  const view = foldEvents(events);

  it('runFailure reads run.failed (plain reason, technical message, minute)', () => {
    const f = runFailure(view, events)!;
    expect(f.plain).toBe('the AI service was too busy to answer');
    expect(f.where).toBe('llm');
    expect(f.error).toContain('overloaded');
    expect(f.minute).toBe(21);
    expect(runFailure(foldEvents(S01.agent), S01.agent)).toBeNull();
  });

  it('runFailure also reads a failed/error status without the event (RunMeta)', () => {
    const p = emptyProjection('r');
    const f = runFailure({ ...p, meta: { ...p.meta, status: 'error' as never } })!;
    expect(f.plain).toBe('an unexpected internal error');
    expect(f.error).toBe('No error message was recorded.');
  });

  it('the cockpit banner: calm sentence, technical details expandable, Start again', () => {
    const onRestart = vi.fn();
    render(<RunFailedBanner failure={runFailure(view, events)!} onRestart={onRestart} />);
    const banner = screen.getByTestId('run-failed');
    expect(banner).toHaveAttribute('role', 'status');
    expect(banner.textContent).toContain(
      'This run stopped because of a system error: the AI service was too busy to answer.',
    );
    const details = banner.querySelector('details')!;
    expect(details.open).toBe(false);
    expect(details.querySelector('summary')!.textContent).toBe('Technical details');
    expect(banner.querySelector('[data-failure-technical]')!.textContent).toBe(
      'llm: anthropic 529 overloaded_error after 3 retries',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Start again' }));
    expect(onRestart).toHaveBeenCalledTimes(1);
  });

  it('the run-ended card says it stopped because of a system error, never "complete"', () => {
    render(
      <RunEndedCard
        view={view}
        baseline={null}
        decisions={[]}
        onExportPdf={() => {}}
        onExportJson={() => {}}
        onDismiss={() => {}}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Run stopped by a system error' })).toBeInTheDocument();
    expect(screen.getByText(/Cause: the AI service was too busy to answer/)).toBeInTheDocument();
  });

  it('a timeline marker and a run-level audit entry', () => {
    expect(eventMarkers(events).at(-1)).toMatchObject({ kind: 'failed', label: 'Run stopped: system error' });
    expect(runLevelEvents(events)).toEqual([
      expect.objectContaining({
        kind: 'failed',
        tone: 'critical',
        text: 'Run stopped because of a system error: the AI service was too busy to answer',
        detail: 'llm: anthropic 529 overloaded_error after 3 retries',
      }),
    ]);
  });

  it('the Audit run list shows the status and the plain reason (technical on hover)', () => {
    render(<RunStatusCell run={{ status: 'failed', error: 'ConditionalCheckFailedException' }} />);
    expect(screen.getByText('failed')).toBeInTheDocument();
    const reason = document.querySelector('[data-run-reason]')!;
    expect(reason.textContent).toBe('the event store could not record a step');
    expect(reason).toHaveAttribute('title', 'ConditionalCheckFailedException');
  });
});

describe('a stopped run reads "stopped", distinct from completed', () => {
  const events = withTail((s) => [
    ev('run.completed', { reason: 'stopped', totals: foldEvents(S01.agent).totals, finalKpis: null }, 21, {
      seq: s + 1,
    }),
  ]);

  it('marker, audit entry and badges', () => {
    expect(eventMarkers(events).at(-1)).toMatchObject({ kind: 'end', label: 'Run stopped (kill switch)' });
    const lv = runLevelEvents(events);
    expect(lv).toEqual([expect.objectContaining({ kind: 'stopped' })]);
    const { container } = render(<RunStatusBadge status="completed" runEvents={lv} />);
    expect(container.querySelector('[data-run-status]')).toHaveAttribute('data-run-status', 'stopped');
    expect(container.textContent).toBe('stopped');
    render(<RunStatusCell run={{ status: 'aborted' }} />);
    expect(screen.getByText('aborted')).toBeInTheDocument();
  });
});

describe('self-recovery (additive events): calm, and never a failure', () => {
  const recovering = withTail(() => [
    ev('run.recovering', { attempt: 1, reason: 'Lambda timeout: 14 min wall clock' }, 21),
  ]);
  const recovered = [...recovering, ev('run.resumed_after_error', { attempt: 1 }, 23)];

  it('recoveryState: recovering, then recovered at the resume minute', () => {
    expect(recoveryState(S01.agent)).toBeNull();
    expect(recoveryState(recovering)).toMatchObject({
      status: 'recovering',
      attempt: 1,
      plain: 'the run took longer than the system allows',
    });
    const r = recoveryState(recovered)!;
    expect(r).toMatchObject({ status: 'recovered', resumedMinute: 23 });
    expect(r.seq).toBe(recovered.at(-1)!.seq);
    expect(recoveryEvents(recovered).map((x) => x.kind)).toEqual(['recovering', 'resumed']);
    // Not a failure: the projection ignores the unknown events and the run stays running.
    expect(runFailure(foldEvents(recovered), recovered)).toBeNull();
  });

  it('banners: "Recovering from a system error…" → "Recovered — resumed at m23" (dismissible)', () => {
    const { rerender } = render(<RunRecoveryBanner recovery={recoveryState(recovering)!} />);
    const b = screen.getByTestId('run-recovery');
    expect(b.textContent).toContain('Recovering from a system error…');
    expect(b.textContent).toContain('attempt 1');
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
    const onDismiss = vi.fn();
    rerender(<RunRecoveryBanner recovery={recoveryState(recovered)!} onDismiss={onDismiss} />);
    expect(screen.getByTestId('run-recovery').textContent).toContain('Recovered — resumed at m23.');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).toHaveBeenCalled();
  });

  it('timeline markers and audit entries', () => {
    const recoveryMarkers = eventMarkers(recovered).filter((m) => m.kind === 'recovery');
    expect(recoveryMarkers.map((m) => m.label)).toEqual([
      'System error — recovering (attempt 1)',
      'Resumed after a system error',
    ]);
    expect(runLevelEvents(recovered).map((e) => [e.kind, e.tone])).toEqual([
      ['recovering', 'warning'],
      ['resumed', 'neutral'],
    ]);
  });

  it('an agent stopped by a system error is listed for the audit', () => {
    const events = withTail(() => [
      ev('agent.aborted', { role: 'ground', reason: 'error', detail: 'fetch failed' }, 21, {
        agentRunId: 'ar-g',
      }),
    ]);
    expect(runLevelEvents(events)).toEqual([
      expect.objectContaining({
        kind: 'agent_error',
        text: 'An agent stopped because of a system error: a connection to a backend service dropped',
      }),
    ]);
  });
});

describe('Space pauses the clock, also while the decision card itself has focus', () => {
  const key = { key: ' ', metaKey: false, ctrlKey: false, altKey: false };
  it('toggles on the page and on the popup card, never on controls or rail cards', () => {
    document.body.innerHTML = `
      <div data-decision-popup><article tabindex="0" id="card"><button id="approve">Approve</button></article></div>
      <div data-approval><span id="rail"></span></div>
      <input id="field" /><main id="page"></main>`;
    const $ = (id: string) => document.getElementById(id);
    expect(spaceTogglesClock(key, $('page'))).toBe(true);
    expect(spaceTogglesClock(key, $('card'))).toBe(true);
    expect(spaceTogglesClock(key, $('approve'))).toBe(false);
    expect(spaceTogglesClock(key, $('rail'))).toBe(false);
    expect(spaceTogglesClock(key, $('field'))).toBe(false);
    expect(spaceTogglesClock({ ...key, key: 'a' }, $('page'))).toBe(false);
    expect(spaceTogglesClock({ ...key, metaKey: true }, $('page'))).toBe(false);
    document.body.innerHTML = '';
  });
});
