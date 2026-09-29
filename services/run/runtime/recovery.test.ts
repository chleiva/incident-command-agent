/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Self-recovery (owner request after the 2026-09-27 demo): failures are contained at the smallest scope (tool call →
 * agent → world process), only an unwritable event log ends a run, and an ended run resumes itself from the event
 * log (≤ MAX_RUN_RESUMES). Also 1b: the final RunMeta status is written with retries in a `finally`.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_RUN_RESUMES,
  validateEvent,
  type EventDraft,
  type LlmRequest,
  type RunEvent,
  type RunResumeRequest,
  type Store,
} from '@ica/schema';
import { EnvSecretStore, MemoryStore, MemoryTraceStore } from '@ica/store';
import minimal from '@ica/schema/fixtures/scenario.minimal.json' with { type: 'json' };
import type { Scenario } from '@ica/schema';
import {
  createRunHandler,
  lambdaSelfInvoker,
  parseContinuation,
  parseResume,
  STOP_MARGIN_MS,
} from '../handler';
import { call, scriptByAgent, step, type ScriptStep } from '../llm/scripted';
import { TOOL_FAILURE_MESSAGE } from './execute';
import { makeHarness, ofType } from './__fixtures__/harness';
import { LOG_UNWRITABLE_AFTER } from './context';
import { buildResumeDigest, resumeBrief } from './resume';
import { VirtualClock } from '../world/clock';

const REPORT = {
  summary: 'Handled the brief; nothing further outstanding.',
  actionsTaken: [],
  openIssues: [],
  recommendations: [],
  citations: [],
};
const throttled = () => Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' });
const invalid = () =>
  Object.assign(new Error('Item size has exceeded the maximum allowed size'), {
    name: 'ValidationException',
  });

/** Store proxy: `fail(method, args)` returns an error to throw instead of calling the real store. */
function faulty(inner: MemoryStore, fail: (method: string, args: unknown[]) => Error | undefined): Store {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver) as unknown;
      if (typeof v !== 'function') return v;
      return (...args: unknown[]) => {
        const err = fail(String(prop), args);
        if (err) return Promise.reject(err);
        return (v as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as unknown as Store;
}
const draftsOf = (args: unknown[]) => (args[1] ?? []) as EventDraft[];
const briefOf = (req: LlmRequest) =>
  req.messages
    .flatMap((m) => m.content)
    .map((c) => ('text' in c ? c.text : ''))
    .join('\n');

describe('1b: the final run status is always written', () => {
  it('retries the final updateRun when the first attempt fails (status matches the final event)', async () => {
    let failures = 0;
    const h = await makeHarness({
      script: scriptByAgent({ orchestrator: [step('Done.', call('report', REPORT))] }),
      wrapStore: (s) =>
        faulty(s, (method, args) => {
          const patch = args[1] as { status?: string } | undefined;
          if (method === 'updateRun' && patch?.status === 'completed' && failures++ === 0)
            return new Error('socket hang up');
          return undefined;
        }),
    });
    const r = await h.run();
    expect(r.status).toBe('completed');
    expect(failures).toBe(2);
    expect((await h.store.getRun(h.runId))!.status).toBe('completed');
    expect((await h.events()).at(-1)!.type).toBe('run.completed');
  });
});

describe('B: failures are contained at the smallest scope', () => {
  it('a tool whose write fails (non-transient) returns an error result; the agent carries on', async () => {
    const h = await makeHarness({
      script: scriptByAgent({
        orchestrator: [
          step('Delegating.', call('delegate', { role: 'maintenance', brief: 'Page an engineer.' })),
          step('Done.', call('report', REPORT)),
        ],
        maintenance: [
          step('Paging.', call('page_engineer', { engineerId: 'eng-1', station: 'MAN' }, 'tu_page')),
          step('Reporting.', call('report', REPORT)),
        ],
      }),
      wrapStore: (s) =>
        faulty(s, (method, args) =>
          method === 'append' &&
          draftsOf(args).some((d) => d.type === 'agent.tool_result' && (d.payload as { ok: boolean }).ok) &&
          draftsOf(args).some((d) => (d.payload as { toolCallId?: string }).toolCallId === 'tu_page')
            ? invalid()
            : undefined,
        ),
    });
    const r = await h.run();
    expect(r.status).toBe('completed');
    const events = await h.events();
    for (const e of events) expect(validateEvent(e).ok).toBe(true);
    const res = ofType(events, 'agent.tool_result').find((e) => e.payload.toolCallId === 'tu_page')!;
    expect(res.payload).toMatchObject({ ok: false, resultPreview: TOOL_FAILURE_MESSAGE });
    expect(ofType(events, 'system.error')[0]!.payload).toMatchObject({
      scope: 'tool',
      tool: 'page_engineer',
    });
    // nothing was changed: the engineer was never paged
    expect((await h.store.getSystemState(h.runId, 'engineers')).engineers!.engineers['eng-1']!.status).toBe(
      'available',
    );
    expect(ofType(events, 'agent.report').map((e) => e.payload.role)).toContain('maintenance');
  });

  it('an unexpected exception ends only that agent; the orchestrator is told and finishes', async () => {
    const h = await makeHarness({
      script: scriptByAgent({
        orchestrator: [
          step('Delegating.', call('delegate', { role: 'ground', brief: 'Plan the stand.' }, 'tu_d')),
          step('Done.', call('report', REPORT)),
        ],
        ground: () => {
          throw new TypeError("Cannot read properties of undefined (reading 'stands')");
        },
      }),
    });
    const r = await h.run();
    expect(r.status).toBe('completed');
    const events = await h.events();
    const aborted = ofType(events, 'agent.aborted').find((e) => e.payload.role === 'ground')!;
    expect(aborted.payload.reason).toBe('error');
    const delegated = ofType(events, 'agent.tool_result').find((e) => e.payload.toolCallId === 'tu_d')!;
    expect(delegated.payload.ok).toBe(false);
    expect(delegated.payload.resultPreview).toMatch(/ground agent stopped early \(error\)/);
    expect(ofType(events, 'run.completed')[0]!.payload.reason).toBe('report');
  });

  it('a failing world process is skipped and recorded; the clock keeps ticking', async () => {
    let failed = 0;
    const h = await makeHarness({
      script: scriptByAgent({
        orchestrator: [
          step('Waiting.', call('set_objective', { objective: 'Hold for the engineer.' })),
          step('Waiting.', call('set_objective', { objective: 'Still holding.' })),
          step('Done.', call('report', REPORT)),
        ],
      }),
      latencyMs: 60_000,
      wrapStore: (s) =>
        faulty(s, (method, args) =>
          method === 'append' && failed < 1 && draftsOf(args).some((d) => d.type === 'world.tick')
            ? (failed++, invalid())
            : undefined,
        ),
    });
    const r = await h.run();
    expect(r.status).toBe('completed');
    const events = await h.events();
    expect(ofType(events, 'system.error').map((e) => e.payload.scope)).toContain('world');
    expect(ofType(events, 'world.tick').length).toBeGreaterThan(3);
  });
});

describe('C: run-level resume from the event log', () => {
  /** Orchestrator: brief maintenance, then (first invocation) keep working until the store breaks. */
  const orchestrator = (iteration: number, req: LlmRequest): ScriptStep => {
    if (/resumed \(attempt 1\)/.test(briefOf(req))) {
      return iteration === 0
        ? step(
            'Resumed: reporting.',
            call('report', { ...REPORT, summary: 'Resumed after the error and closed the incident.' }),
          )
        : step('Done.', call('report', REPORT));
    }
    if (iteration === 0)
      return step(
        'Opening.',
        call('open_incident', { title: 'Door caution', summary: 'FWD cargo door caution on stand.' }),
      );
    if (iteration === 1)
      return step('Delegating.', call('delegate', { role: 'maintenance', brief: 'Page an engineer.' }));
    return step('Working.', call('set_objective', { objective: `Keep going ${iteration}` }));
  };

  it('an unwritable event log ends the run, a resume is scheduled, and the resumed run completes', async () => {
    const scheduled: RunResumeRequest[] = [];
    let breakAfterReport = false;
    let failuresLeft = LOG_UNWRITABLE_AFTER;
    const h = await makeHarness({
      script: scriptByAgent({
        orchestrator,
        maintenance: [
          step('Paging.', call('page_engineer', { engineerId: 'eng-1', station: 'MAN' })),
          step('Reporting.', call('report', REPORT)),
        ],
      }),
      scheduleResume: async (req) => void scheduled.push(req),
      wrapStore: (s) =>
        faulty(s, (method, args) => {
          if (method !== 'append') return undefined;
          if (draftsOf(args).some((d) => d.type === 'agent.report')) breakAfterReport = true;
          // After maintenance reported, the next appends fail (throttling that outlasts the store's retries).
          if (
            breakAfterReport &&
            failuresLeft > 0 &&
            !draftsOf(args).some((d) => d.type === 'agent.report')
          ) {
            failuresLeft--;
            return throttled();
          }
          return undefined;
        }),
    });
    const first = await h.run();
    expect(first.status).toBe('recovering');
    expect(scheduled).toEqual([
      { runId: h.runId, attempt: 1, reason: expect.stringMatching(/event log unwritable/) },
    ]);
    let events = await h.events();
    expect(ofType(events, 'run.recovering')[0]!.payload).toMatchObject({
      attempt: 1,
      maxAttempts: MAX_RUN_RESUMES,
    });
    expect(ofType(events, 'run.completed')).toHaveLength(0);
    expect((await h.store.getRun(h.runId))!.status).toBe('running');
    const stoppedAt = events.at(-1)!.simMinute;

    const second = await h.resume(1);
    expect(second.status).toBe('completed');
    events = await h.events();
    for (const e of events) expect(validateEvent(e).ok).toBe(true);
    const resumed = ofType(events, 'run.resumed_after_error')[0]!;
    expect(resumed.payload.attempt).toBe(1);
    expect(resumed.payload.fromMinute).toBeGreaterThanOrEqual(Math.floor(stoppedAt));
    // the world was rebuilt from the store: the engineer paged before the failure is still paged/travelling
    expect(['paged', 'travelling', 'on_site']).toContain(
      (await h.store.getSystemState(h.runId, 'engineers')).engineers!.engineers['eng-1']!.status,
    );
    // no id reused: every agent run id is unique
    const started = ofType(events, 'agent.started').map((e) => e.agentRunId);
    expect(new Set(started).size).toBe(started.length);
    expect(ofType(events, 'run.completed')[0]!.payload.reason).toBe('report');
    expect((await h.store.getRun(h.runId))!.status).toBe('completed');
    // the same attempt is never resumed twice (Lambda may deliver the async event again)
    expect((await h.resume(1)).status).toBe('skipped');
  });

  it('when resumes are exhausted the run fails as before', async () => {
    const scheduled: RunResumeRequest[] = [];
    const h = await makeHarness({
      script: scriptByAgent({ orchestrator: [step('Done.', call('report', REPORT))] }),
      scheduleResume: async (req) => void scheduled.push(req),
      wrapStore: (s) =>
        faulty(s, (method, args) =>
          method === 'append' && draftsOf(args).some((d) => d.type === 'agent.started')
            ? throttled()
            : undefined,
        ),
    });
    expect((await h.run()).status).toBe('recovering');
    expect((await h.resume(1)).status).toBe('recovering');
    const last = await h.resume(2);
    expect(last.status).toBe('failed');
    expect(scheduled.map((s) => s.attempt)).toEqual([1, 2]);
    const events = await h.events();
    expect(events.at(-1)!.type).toBe('run.failed');
    expect((await h.store.getRun(h.runId))!.status).toBe('failed');
  });

  it('the resume brief is built from the log alone (objective, decisions, open approvals, reports)', () => {
    const ev = (seq: number, type: string, payload: unknown, extra: Record<string, unknown> = {}) =>
      ({
        runId: 'r',
        seq,
        type,
        actor: { kind: 'agent', role: 'orchestrator' },
        simMinute: seq,
        simTime: '2026-06-12T06:00:00Z',
        wallTime: '2026-06-12T06:00:00Z',
        payload,
        ...extra,
      }) as unknown as RunEvent;
    const events = [
      ev(1, 'agent.tool_call', {
        toolCallId: 't1',
        tool: 'set_objective',
        system: 'runtime',
        tier: 'execute',
        args: { objective: 'Release by 08:00' },
      }),
      ev(
        2,
        'agent.started',
        { role: 'maintenance', brief: 'Page an engineer' },
        { agentRunId: 'ar-maintenance-1' },
      ),
      ev(
        3,
        'agent.report',
        {
          role: 'maintenance',
          report: { ...REPORT, summary: 'Engineer on the way', openIssues: ['NDT needed'] },
        },
        { agentRunId: 'ar-maintenance-1' },
      ),
      ev(4, 'agent.started', { role: 'ground', brief: 'Plan the stand' }, { agentRunId: 'ar-ground-1' }),
    ];
    const digest = buildResumeDigest(events, { record: { timeline: {} } } as never, [], 1, 12.5);
    expect(digest).toMatchObject({
      objective: 'Release by 08:00',
      specialistsReported: [expect.stringMatching(/^maintenance \(m3\): Engineer on the way/)],
      specialistsInterrupted: [expect.stringMatching(/^ground/)],
      openIssues: ['NDT needed'],
      resumedAtMinute: 12.5,
    });
    const brief = resumeBrief(digest);
    expect(brief).toMatch(/resumed \(attempt 1\) at sim minute 12.5/);
    expect(brief).toMatch(/<tool_result source="runtime:resume">/);
  });
});

describe('C: the Run Lambda handler resumes itself (baseline runs too)', () => {
  const scenario = minimal as unknown as Scenario;
  async function baselineRun(store: MemoryStore, runId: string) {
    await store.putScenario(scenario);
    await store.createRun({
      runId,
      scenarioId: scenario.id,
      scenarioTitle: scenario.title,
      mode: 'baseline',
      status: 'created',
      createdAt: new Date().toISOString(),
      simMinute: 0,
      lastSeq: 0,
      totals: { inputTokens: 0, outputTokens: 0, costUsd: 0, toolCalls: 0, iterations: 0, wallMs: 0 },
      speed: 60,
    });
  }

  it('out of Lambda time with work remaining → run.continuing + self-invoke; the continued invocation completes', async () => {
    const store = new MemoryStore();
    await baselineRun(store, 'lambda-resume-1');
    const invocations: { runId: string; continuation: { attempt: number } }[] = [];
    const handler = createRunHandler(() => ({
      store,
      traces: new MemoryTraceStore(),
      secrets: new EnvSecretStore({}),
      knowledge: async () => ({ search: async () => [] }),
      env: {},
      clock: new VirtualClock(),
      guardIntervalMs: 5,
      scheduleResume: async (req) => {
        expect(req.kind).toBe('continuation');
        invocations.push({ runId: req.runId, continuation: { attempt: req.attempt } });
      },
    }));
    // Less than the stop margin left: the run stops at once with its whole chronology still to do.
    const r1 = await handler(
      { runId: 'lambda-resume-1' },
      { getRemainingTimeInMillis: () => STOP_MARGIN_MS - 1 },
    );
    expect(r1.status).toBe('continuing');
    expect(invocations).toEqual([{ runId: 'lambda-resume-1', continuation: { attempt: 1 } }]);
    const r2 = await handler(invocations[0]!);
    expect(r2.status).toBe('completed');
    const { events } = await store.listEvents('lambda-resume-1', 0, 100_000);
    for (const e of events) expect(validateEvent(e).ok).toBe(true);
    // A compute-limit hand-over is a continuation, never an error recovery.
    expect(ofType(events, 'run.continuing')).toHaveLength(1);
    expect(ofType(events, 'run.continued')).toHaveLength(1);
    expect(ofType(events, 'run.recovering')).toHaveLength(0);
    expect(ofType(events, 'run.resumed_after_error')).toHaveLength(0);
    expect(ofType(events, 'run.started')).toHaveLength(1);
    // the chronology continued: every baseline step ran exactly once
    expect(ofType(events, 'baseline.action')).toHaveLength(scenario.baseline.length);
    expect((await store.getRun('lambda-resume-1'))!.status).toBe('completed');
    // a duplicate delivery of the continuation event is skipped
    expect((await handler(invocations[0]!)).status).toBe('skipped');
  });
});

describe('handler: continuation vs resume invocations', () => {
  it('parses continuation and resume parts, and self-invokes with the matching payload', async () => {
    expect(parseContinuation({ attempt: 3 })).toEqual({ attempt: 3 });
    expect(parseContinuation({ attempt: 0 })).toBeUndefined();
    expect(parseContinuation({ attempt: 1.5 })).toBeUndefined();
    expect(parseContinuation('x')).toBeUndefined();
    expect(parseResume({ attempt: MAX_RUN_RESUMES + 1 })).toBeUndefined();
    const sent: unknown[] = [];
    const client = {
      send: async (cmd: { input: { Payload: Uint8Array } }) => {
        sent.push(JSON.parse(new TextDecoder().decode(cmd.input.Payload)));
        return { StatusCode: 202 };
      },
    };
    const invoke = lambdaSelfInvoker('fn', client as never);
    await invoke({ runId: 'r1', attempt: 2, reason: 'x', kind: 'continuation' });
    await invoke({ runId: 'r1', attempt: 1, reason: 'y' });
    expect(sent).toEqual([
      { runId: 'r1', continuation: { attempt: 2 } },
      { runId: 'r1', resume: { attempt: 1 } },
    ]);
  });
});
