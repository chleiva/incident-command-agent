/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Continuation (live 2026-09-29): a human-paced run outlives the Run Lambda's 15-minute limit. Reaching it with work
 * remaining is a normal hand-over to a fresh invocation (`run.continuing` → `run.continued`, its own counter
 * `MAX_RUN_CONTINUATIONS`), never an error resume (`run.recovering`, `MAX_RUN_RESUMES`).
 */
import { describe, expect, it } from 'vitest';
import {
  LAMBDA_TIMEOUT_ABORT,
  MAX_RUN_CONTINUATIONS,
  MAX_RUN_RESUMES,
  foldEvents,
  maxRunContinuationsFromEnv,
  validateEvent,
  type Actor,
  type EventDraft,
  type LlmRequest,
  type RunResumeRequest,
  type Store,
} from '@ica/schema';
import type { MemoryStore } from '@ica/store';
import { call, scriptByAgent, step, type ScriptStep } from '../llm/scripted';
import { makeHarness, ofType, type Harness } from './__fixtures__/harness';
import { LOG_UNWRITABLE_AFTER } from './context';
import { continuationsExhaustedNote } from './run';

const REPORT = {
  summary: 'Handled the brief; the remaining action is waiting on the duty manager.',
  actionsTaken: [],
  openIssues: [],
  recommendations: [],
  citations: [],
};
const MSG = {
  cohortIds: ['c-general'],
  channel: 'sms',
  body: 'Your flight ACX101 is delayed by a door check. Next update 06:30.',
};
const DUTY_MANAGER: Actor = { kind: 'human', name: 'Sam Okafor', roleTitle: 'Duty Manager' };
/** Virtual real time each invocation runs before the "Lambda" guard fires. */
const INVOCATION_MS = 3 * 60_000;

const briefOf = (req: LlmRequest) =>
  req.messages
    .flatMap((m) => m.content)
    .map((c) => ('text' in c ? c.text : ''))
    .join('\n');

/**
 * First invocation: the orchestrator delegates to the passenger agent, which proposes a message and waits for a
 * person. Every continuation: the orchestrator reads the resume brief and reports (the approval is still open).
 */
const orchestrator = (iteration: number, req: LlmRequest): ScriptStep => {
  if (/continued \(continuation \d+\)/.test(briefOf(req)))
    return step('Picked up again; the message is still waiting on the duty manager.', call('report', REPORT));
  if (/resumed \(attempt \d+\)/.test(briefOf(req))) return step('Resumed.', call('report', REPORT));
  return iteration === 0
    ? step('Delegating.', call('delegate', { role: 'passenger', brief: 'Inform the passengers.' }))
    : step('Done.', call('report', REPORT));
};

async function continuationHarness(
  opts: { maxRunContinuations?: number; wrapStore?: (s: MemoryStore) => Store } = {},
) {
  const scheduled: RunResumeRequest[] = [];
  const h = await makeHarness({
    bus: true,
    policy: 'human',
    script: scriptByAgent({
      orchestrator,
      passenger: [
        step('Proposing the first update.', call('send_passenger_message', MSG, 'tu_msg')),
        step('Reporting.', call('report', REPORT)),
      ],
    }),
    scheduleResume: async (req) => void scheduled.push(req),
    ...(opts.maxRunContinuations !== undefined ? { maxRunContinuations: opts.maxRunContinuations } : {}),
    ...(opts.wrapStore ? { wrapStore: opts.wrapStore } : {}),
  });
  return { h, scheduled };
}

/** The Run Lambda's remaining-time guard: aborts with LAMBDA_TIMEOUT_ABORT after `ms` of (virtual) real time. */
function lambdaGuard(h: Harness, ms = INVOCATION_MS): AbortSignal {
  const ac = new AbortController();
  void h.clock.sleep(ms).then(() => ac.abort(LAMBDA_TIMEOUT_ABORT));
  return ac.signal;
}

/** The API's role: a person decides (writes `approval.decision`). */
async function decide(h: Harness, approvalId: string) {
  const last = (await h.events()).at(-1)!;
  await h.store.append(h.runId, [
    {
      type: 'approval.decision',
      actor: DUTY_MANAGER,
      simMinute: last.simMinute,
      simTime: last.simTime,
      payload: { approvalId, decision: 'approve', decidedBy: DUTY_MANAGER },
    },
  ]);
}

const ERROR_TYPES = ['run.recovering', 'run.resumed_after_error', 'run.failed', 'system.error'];

describe('continuation at the Lambda compute limit', () => {
  it('hands over 3 times without an error, keeps the pending approval, then completes once a person decides', async () => {
    const { h, scheduled } = await continuationHarness();
    const r0 = await h.run(lambdaGuard(h));
    expect(r0.status).toBe('continuing');
    const approvalId = ofType(await h.events(), 'agent.proposal')[0]!.payload.approvalId;
    expect((await h.store.listApprovals(h.runId, 'pending')).map((a) => a.approvalId)).toEqual([approvalId]);

    for (const attempt of [1, 2]) {
      expect((await h.store.getRun(h.runId))!.status).toBe('running');
      const r = await h.continue(attempt, lambdaGuard(h));
      expect(r.status).toBe('continuing');
      // Still the same pending approval, never expired or re-proposed.
      expect((await h.store.listApprovals(h.runId, 'pending')).map((a) => a.approvalId)).toEqual([
        approvalId,
      ]);
    }
    expect(scheduled).toEqual(
      [1, 2, 3].map((attempt) => ({
        runId: h.runId,
        attempt,
        reason: expect.stringMatching(/compute time limit/),
        kind: 'continuation',
      })),
    );

    // The third continuation: the duty manager approves the message; the re-attached approval executes.
    void h.clock.sleep(60_000).then(() => decide(h, approvalId));
    const last = await h.continue(3, lambdaGuard(h, 10 * INVOCATION_MS));
    expect(last.status).toBe('completed');
    expect(last.reason).toBe('report');

    const events = await h.events();
    for (const e of events) expect(validateEvent(e).ok, e.type).toBe(true);
    expect(events.filter((e) => ERROR_TYPES.includes(e.type))).toEqual([]);
    expect(ofType(events, 'run.continuing').map((e) => e.payload.attempt)).toEqual([1, 2, 3]);
    expect(ofType(events, 'run.continuing')[0]!.payload.maxAttempts).toBe(MAX_RUN_CONTINUATIONS);
    const continued = ofType(events, 'run.continued');
    expect(continued.map((e) => [e.payload.attempt, e.payload.pendingApprovals])).toEqual([
      [1, 1],
      [2, 1],
      [3, 1],
    ]);
    // The sim clock continued, never restarted.
    const minutes = continued.map((e) => e.payload.atSimMinute);
    expect([...minutes].sort((a, b) => a - b)).toEqual(minutes);
    expect(minutes[0]).toBeGreaterThan(0);
    expect(ofType(events, 'run.started')).toHaveLength(1);
    // One proposal only, executed with the person as the approver after the decision.
    expect(ofType(events, 'agent.proposal')).toHaveLength(1);
    const result = ofType(events, 'agent.tool_result').find((e) => e.payload.toolCallId === 'tu_msg')!;
    expect(result.payload.ok).toBe(true);
    expect(Object.values(foldEvents(events).systems.pss.messages)[0]).toMatchObject({
      body: MSG.body,
      approvedBy: DUTY_MANAGER,
    });
    const meta = (await h.store.getRun(h.runId))!;
    expect(meta).toMatchObject({ status: 'completed', continuationAttempt: 3 });
    expect(meta.resumeAttempt).toBeUndefined();
    const run = foldEvents(events);
    expect(run.meta.recovery).toBeUndefined();
    expect(run.meta.continuation).toMatchObject({ status: 'continued', attempt: 3 });
    // A duplicate delivery of a continuation event is skipped.
    expect((await h.continue(3)).status).toBe('skipped');
  });

  it('keeps pause and speed, and applies a control request written during the hand-over', async () => {
    const { h } = await continuationHarness();
    const control = async (action: 'pause' | 'resume' | 'set_speed', speed?: number) => {
      const last = (await h.events()).at(-1)!;
      await h.store.append(h.runId, [
        {
          type: 'control.requested',
          actor: DUTY_MANAGER,
          simMinute: last.simMinute,
          simTime: last.simTime,
          payload: { action, ...(speed ? { speed } : {}) },
        } as EventDraft,
      ]);
    };
    void h.clock.sleep(30_000).then(async () => {
      await control('set_speed', 12);
      await control('pause');
    });
    expect((await h.run(lambdaGuard(h))).status).toBe('continuing');
    expect((await h.store.getRun(h.runId))!).toMatchObject({ status: 'paused', speed: 12 });
    const pausedAt = (await h.events()).filter((e) => e.type === 'run.paused').at(-1)!.simMinute;

    // Written while no invocation was listening: the next one applies it.
    await control('resume');
    let speedSeen = 0;
    const r1 = await h.continue(
      1,
      (() => {
        const s = lambdaGuard(h);
        void h.clock.sleep(1).then(() => (speedSeen = h.ctx!.sim.speed));
        return s;
      })(),
    );
    expect(r1.status).toBe('continuing');
    expect(speedSeen).toBe(12);
    const events = await h.events();
    const continued = ofType(events, 'run.continued')[0]!;
    // The clock stayed paused through the hand-over, then the late resume request was applied.
    expect(continued.payload.atSimMinute).toBeCloseTo(pausedAt, 1);
    const resumed = events.filter((e) => e.type === 'run.resumed' && e.seq > continued.seq);
    expect(resumed).toHaveLength(1);
    expect(events.filter((e) => ERROR_TYPES.includes(e.type))).toEqual([]);
  });

  it('when continuations run out the run completes as stopped with a plain note (not failed)', async () => {
    const { h, scheduled } = await continuationHarness({ maxRunContinuations: 1 });
    expect((await h.run(lambdaGuard(h))).status).toBe('continuing');
    const r = await h.continue(1, lambdaGuard(h));
    expect(r).toMatchObject({ status: 'completed', reason: 'stopped' });
    expect(r.abortReason).toBeUndefined();
    expect(scheduled.map((s) => s.attempt)).toEqual([1]);
    const events = await h.events();
    expect(events.filter((e) => ERROR_TYPES.includes(e.type))).toEqual([]);
    const done = ofType(events, 'run.completed')[0]!;
    expect(done.payload.reason).toBe('stopped');
    expect(done.payload.note).toBe(continuationsExhaustedNote(1));
    expect((await h.store.getRun(h.runId))!.status).toBe('completed');
    expect(foldEvents(events).meta.completedNote).toMatch(/real time/);
  });

  it('the default limit reads "about 3 hours of real time"', () => {
    expect(continuationsExhaustedNote(MAX_RUN_CONTINUATIONS)).toMatch(
      /^Stopped after about 3 hours of real time/,
    );
    expect(continuationsExhaustedNote(0)).toMatch(/about 14 minutes/);
    expect(maxRunContinuationsFromEnv({})).toBe(12);
    expect(maxRunContinuationsFromEnv({ MAX_RUN_CONTINUATIONS: '4' })).toBe(4);
    expect(maxRunContinuationsFromEnv({ MAX_RUN_CONTINUATIONS: '0' })).toBe(0);
    expect(maxRunContinuationsFromEnv({ MAX_RUN_CONTINUATIONS: '999' })).toBe(12);
    expect(maxRunContinuationsFromEnv({ MAX_RUN_CONTINUATIONS: 'lots' })).toBe(12);
  });

  it('an error after continuations still uses the error-resume allowance (MAX_RUN_RESUMES), counted apart', async () => {
    let breakLog = false;
    let failuresLeft = LOG_UNWRITABLE_AFTER;
    const { h, scheduled } = await continuationHarness({
      wrapStore: (s) =>
        new Proxy(s, {
          get(target, prop, receiver) {
            const v = Reflect.get(target, prop, receiver) as unknown;
            if (prop !== 'append' || typeof v !== 'function') return v;
            return (...args: unknown[]) => {
              if (breakLog && failuresLeft > 0) {
                failuresLeft--;
                return Promise.reject(
                  Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' }),
                );
              }
              return (v as (...a: unknown[]) => unknown).apply(target, args);
            };
          },
        }) as unknown as Store,
    });
    expect((await h.run(lambdaGuard(h))).status).toBe('continuing');
    // In the continued invocation the event log becomes unwritable: a real error → run.recovering (attempt 1).
    void h.clock.sleep(30_000).then(() => (breakLog = true));
    const r = await h.continue(1, lambdaGuard(h));
    expect(r.status).toBe('recovering');
    expect(scheduled.map((s) => [s.kind ?? 'error', s.attempt])).toEqual([
      ['continuation', 1],
      ['error', 1],
    ]);
    const recovering = ofType(await h.events(), 'run.recovering')[0]!;
    expect(recovering.payload).toMatchObject({ attempt: 1, maxAttempts: MAX_RUN_RESUMES });
    // The resume keeps the continuation count; the next compute-limit hand-over is continuation 2.
    const resumed = await h.resume(1, lambdaGuard(h));
    expect(resumed.status).toBe('continuing');
    expect(scheduled.at(-1)).toMatchObject({ kind: 'continuation', attempt: 2 });
    expect((await h.store.getRun(h.runId))!).toMatchObject({ resumeAttempt: 1, continuationAttempt: 1 });
  });
});
