/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** Presenter pace (demo review 2): 15× until the first decision card, then 6× via the control route. */
import { generateDaySchedule } from '@ica/network';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReportIncidentDialog, type ReportRequest } from '../components/network/ReportIncidentDialog';
import { PRESENTER_PACE_KEY, useUi } from '../store/ui';
import {
  PACE_FAST,
  PACE_SLOW,
  PACE_TOAST,
  markManualSpeed,
  paceStep,
  startSpeed,
  usePace,
  usePresenterPace,
} from './presenterPace';

function Harness(props: { runId: string; pending: number; speed?: number; setSpeed: (s: number) => void }) {
  usePresenterPace(
    props.runId,
    { pendingDecisions: props.pending, speed: props.speed, enabled: true },
    props.setSpeed,
  );
  return null;
}

beforeEach(() => {
  usePace.setState({ runs: {} });
  useUi.setState({ toasts: [], presenterPace: false });
  window.localStorage.clear();
  window.sessionStorage.clear();
});
afterEach(() => vi.restoreAllMocks());

describe('presenter pace', () => {
  it('paceStep: slow at the first decision; a speed change by someone else stops pacing', () => {
    expect(paceStep(undefined, { pendingDecisions: 1, speed: 15 })).toBeNull();
    expect(paceStep('fast', { pendingDecisions: 0, speed: 15 })).toBeNull();
    expect(paceStep('fast', { pendingDecisions: 1, speed: 15 })).toBe('slow');
    expect(paceStep('fast', { pendingDecisions: 0, speed: 30 })).toBe('manual');
    expect(paceStep('fast', { pendingDecisions: 0, speed: undefined })).toBeNull();
    expect(paceStep('done', { pendingDecisions: 3, speed: 6 })).toBeNull();
    expect(paceStep('manual', { pendingDecisions: 3, speed: 15 })).toBeNull();
  });

  it('default OFF; the start speed is 15× only when on; the preference persists per viewer', () => {
    expect(useUi.getState().presenterPace).toBe(false);
    expect(startSpeed(6, false)).toBe(6);
    expect(startSpeed(6, true)).toBe(PACE_FAST);
    useUi.getState().setPresenterPace(true);
    expect(window.localStorage.getItem(PRESENTER_PACE_KEY)).toBe('on');
    // Blocked storage never throws.
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => useUi.getState().setPresenterPace(false)).not.toThrow();
    expect(useUi.getState().presenterPace).toBe(false);
  });

  it('a paced run slows to 6× once, with a toast, when the first decision card appears', () => {
    const setSpeed = vi.fn();
    usePace.getState().arm('run-1');
    const { rerender } = render(<Harness runId="run-1" pending={0} speed={15} setSpeed={setSpeed} />);
    expect(setSpeed).not.toHaveBeenCalled();
    rerender(<Harness runId="run-1" pending={1} speed={15} setSpeed={setSpeed} />);
    expect(setSpeed).toHaveBeenCalledTimes(1);
    expect(setSpeed).toHaveBeenCalledWith(PACE_SLOW);
    expect(useUi.getState().toasts.map((t) => t.title)).toEqual([PACE_TOAST]);
    expect(PACE_TOAST).toBe('Slowed to 6× — decision needed');
    expect(usePace.getState().runs['run-1']).toBe('done');
    rerender(<Harness runId="run-1" pending={2} speed={6} setSpeed={setSpeed} />);
    expect(setSpeed).toHaveBeenCalledTimes(1);
  });

  it('respects a manual speed change: no automatic adjustment afterwards', () => {
    const setSpeed = vi.fn();
    usePace.getState().arm('run-2');
    const { rerender } = render(<Harness runId="run-2" pending={0} speed={15} setSpeed={setSpeed} />);
    act(() => markManualSpeed('run-2'));
    rerender(<Harness runId="run-2" pending={1} speed={15} setSpeed={setSpeed} />);
    expect(setSpeed).not.toHaveBeenCalled();
    expect(usePace.getState().runs['run-2']).toBe('manual');
    // A speed changed elsewhere (another tab) counts as manual too.
    usePace.getState().arm('run-3');
    rerender(<Harness runId="run-3" pending={0} speed={30} setSpeed={setSpeed} />);
    rerender(<Harness runId="run-3" pending={1} speed={30} setSpeed={setSpeed} />);
    expect(setSpeed).not.toHaveBeenCalled();
    expect(usePace.getState().runs['run-3']).toBe('manual');
  });

  it('runs not started with presenter pace are never touched', () => {
    const setSpeed = vi.fn();
    render(<Harness runId="run-4" pending={2} speed={6} setSpeed={setSpeed} />);
    expect(setSpeed).not.toHaveBeenCalled();
  });

  it('the report dialog has a "Presenter pace" checkbox mirroring the ⌘K toggle; on, it starts at 15×', async () => {
    const schedule = generateDaySchedule('accent-air', '2026-09-27');
    const t = Date.parse('2026-09-27T05:50:00Z');
    const flight = schedule.flights.find((f) => f.flight === 'ACX125')!;
    const onStart = vi.fn(async (_r: ReportRequest) => 'run-x');
    render(
      <ReportIncidentDialog
        open
        onOpenChange={() => {}}
        schedule={schedule}
        flight={flight}
        t={t}
        onStart={onStart}
      />,
    );
    const box = screen.getByRole('checkbox', { name: /Presenter pace/ });
    expect(box).not.toBeChecked();
    fireEvent.click(box);
    expect(useUi.getState().presenterPace).toBe(true);
    expect(screen.getByRole('combobox', { name: /Speed/ })).toBeDisabled();
    act(() => useUi.getState().setPresenterPace(false));
    expect(box).not.toBeChecked();
    act(() => useUi.getState().setPresenterPace(true));
    expect(box).toBeChecked();
    const option = await screen.findAllByRole('radio');
    fireEvent.click(option.find((o) => !(o as HTMLInputElement).disabled)!);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(onStart).toHaveBeenCalled());
    expect(onStart.mock.calls[0]![0]).toMatchObject({ presenterPace: true, speed: PACE_FAST });
  });
});
