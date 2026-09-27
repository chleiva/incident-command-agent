/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Regressions from the first live AWS run (run-20260926-235945-0uo6tt, claude-sonnet-5). The recorded tool calls
 * are in `__fixtures__/live-run-1.json`; everything here runs on the scripted provider (no network).
 */
import { describe, expect, it } from 'vitest';
import type { LlmMessage, RunEvent } from '@ica/schema';
import { maintenance } from '../agents/maintenance';
import { validateToolArgs } from '../guardrails/validate';
import { call, type createScriptedProvider, scriptByAgent, step, type ScriptStep } from '../llm/scripted';
import { fakeRegistry, fakeRoles } from './__fixtures__/registry';
import { makeHarness, ofType } from './__fixtures__/harness';
import live from './__fixtures__/live-run-1.json' with { type: 'json' };
import { normaliseRoleCall, repairLeakedParameters } from './call-repair';
import { reportTool } from './tools';

type Recorded = { id: string; name: string; input: Record<string, unknown> };
const ORCH_TURN = live.orchestratorTurn as Recorded[];
const MX = live.maintenanceReports as Recorded[];
/** i005 `{}`, i006–i009 leaked markup inside `summary`, i010 the placeholder report. */
const [EMPTY, LEAK_1, , , LEAK_SHORT, PLACEHOLDER] = MX;

const ORCH_REPORT = {
  summary: 'Coordinated the door strike: specialists briefed and their reports received.',
  openIssues: [],
  recommendations: [],
  citations: [],
};

const replay = (c: Recorded) => call(c.name, structuredClone(c.input), c.id);

/** The real maintenance report schema on the fake registry (the fake roles use the plain AgentReport). */
function registryWithRealMaintenanceSchema() {
  return fakeRegistry({
    roles: {
      ...fakeRoles,
      maintenance: { ...fakeRoles.maintenance, reportSchema: maintenance.reportSchema },
    },
  });
}

function toolResults(msg: LlmMessage | undefined) {
  return (msg?.content ?? []).filter(
    (b): b is Extract<LlmMessage['content'][number], { type: 'tool_result' }> => b.type === 'tool_result',
  );
}

describe('live run 1, bug 1: role-named tool calls are delegate calls', () => {
  it('runs the recorded 5-block turn as 5 concurrent delegations, answered under the original ids', async () => {
    const h = await makeHarness({
      script: scriptByAgent({
        orchestrator: [
          step('Delegating in parallel.', ...ORCH_TURN.map(replay)),
          step('Done.', call('report', ORCH_REPORT)),
        ],
      }),
    });
    const provider = h.deps.providers!.scripted as ReturnType<typeof createScriptedProvider>;
    await h.run();
    const events = await h.events();

    expect(ofType(events, 'guardrail.blocked')).toEqual([]);
    const calls = ofType(events, 'agent.tool_call').filter((e) => e.payload.tool === 'delegate');
    expect(calls.map((e) => e.payload.toolCallId)).toEqual(ORCH_TURN.map((c) => c.id));
    expect(calls.map((e) => e.payload.normalisedFrom)).toEqual([
      undefined,
      'ground',
      'flightops',
      'passenger',
      'record',
    ]);
    expect(calls.map((e) => e.payload.args.role)).toEqual([
      'maintenance',
      'ground',
      'flightops',
      'passenger',
      'record',
    ]);

    // All five specialists start before any of them reports (concurrent, like real delegate calls).
    const started = ofType(events, 'agent.started').filter((e) => e.payload.role !== 'orchestrator');
    const reports = ofType(events, 'agent.report').filter((e) => e.payload.role !== 'orchestrator');
    expect(started).toHaveLength(5);
    expect(reports).toHaveLength(5);
    expect(Math.max(...started.map((e) => e.seq))).toBeLessThan(Math.min(...reports.map((e) => e.seq)));
    expect(started.map((e) => e.payload.brief)).toEqual(ORCH_TURN.map((c) => c.input.brief));

    // The orchestrator's next request answers every ORIGINAL tool_use id, in order, without errors.
    const next = provider.calls.find((c) => c.info.role === 'orchestrator' && c.info.iteration === 1)!;
    const assistant = next.req.messages.at(-2)!;
    expect(assistant.content.filter((b) => b.type === 'tool_use').map((b) => 'name' in b && b.name)).toEqual([
      'delegate',
      'ground',
      'flightops',
      'passenger',
      'record',
    ]);
    const results = toolResults(next.req.messages.at(-1));
    expect(results.map((r) => r.toolUseId)).toEqual(ORCH_TURN.map((c) => c.id));
    expect(results.every((r) => !r.isError)).toBe(true);
  });

  it('never normalises for an agent without delegate (still an unknown tool)', async () => {
    const h = await makeHarness({
      script: scriptByAgent({
        orchestrator: [step('Delegating.', call('delegate', { role: 'maintenance', brief: 'Assess it.' }))],
        maintenance: [step('Asking ground.', call('ground', { brief: 'Stand?' }, 'tu_mx_ground'))],
      }),
    });
    await h.run();
    const blocked = ofType(await h.events(), 'guardrail.blocked');
    expect(blocked.map((e) => e.payload.reason)).toContain("unknown tool 'ground'");
  });

  it('normaliseRoleCall: brief from input.brief, else the JSON input; real tools are left alone', () => {
    const roles = ['maintenance', 'ground'];
    const has = (n: string) => n === 'delegate' || n === 'report';
    expect(normaliseRoleCall({ id: 'a', name: 'ground', input: { brief: 'b' } }, roles, has)).toEqual({
      id: 'a',
      name: 'delegate',
      input: { role: 'ground', brief: 'b' },
      normalisedFrom: 'ground',
    });
    expect(normaliseRoleCall({ id: 'b', name: 'ground', input: { task: 't' } }, roles, has).input).toEqual({
      role: 'ground',
      brief: '{"task":"t"}',
    });
    const real = { id: 'c', name: 'report', input: {} };
    expect(normaliseRoleCall(real, roles, has)).toBe(real);
    expect(normaliseRoleCall({ id: 'd', name: 'author', input: {} }, roles, has).name).toBe('author');
  });
});

describe('live run 1, bug 2: robust report', () => {
  it('recovers arguments leaked as tool-call markup inside summary (recorded attempts i006–i009)', () => {
    for (const attempt of MX.slice(1, 5)) {
      const { input, repaired } = repairLeakedParameters(attempt.input);
      expect(repaired).toEqual(['actionsTaken']);
      expect(input.summary).not.toMatch(/<\/?parameter/);
      expect(Array.isArray(input.actionsTaken)).toBe(true);
      expect((input.actionsTaken as string[]).length).toBeGreaterThan(5);
      expect(Object.keys(input)).toEqual(expect.arrayContaining(Object.keys(attempt.input)));
    }
    // A well-formed input is returned as is.
    const clean = { summary: 'Fine summary with nothing leaked.', openIssues: [] };
    expect(repairLeakedParameters(clean)).toEqual({ input: clean, repaired: [] });
  });

  it('explains invalid arguments: keys received, missing, unexpected and per-field errors', () => {
    const tool = { inputSchema: maintenance.reportSchema };
    const empty = validateToolArgs(tool, EMPTY.input);
    expect(!empty.ok && empty.errors).toEqual([
      'received keys: (none)',
      'missing required: summary, actionsTaken, openIssues, recommendations, citations',
    ]);
    const wrong = validateToolArgs(tool, {
      ...LEAK_1.input,
      openIssues: 'one',
      decisionNeededFrom: 3,
      bogus: 1,
    });
    expect(!wrong.ok && wrong.errors).toEqual([
      'received keys: summary, openIssues, recommendations, citations, provisionalReading, engineerEtaMinute, estimatedServiceableMinute, decisionNeededFrom, bogus',
      'missing required: actionsTaken',
      'unexpected keys (not allowed): bogus',
      '/openIssues: must be array',
      '/decisionNeededFrom: must be string',
    ]);
    // The model-facing report schema: actionsTaken optional, extra keys allowed, other required fields kept.
    const relaxed = reportTool(maintenance).inputSchema as {
      required: string[];
      additionalProperties?: boolean;
    };
    expect(relaxed.required).toEqual(['summary', 'openIssues', 'recommendations', 'citations']);
    expect(relaxed.additionalProperties).toBeUndefined();
  });

  it('replays the recorded maintenance attempts: {} is explained, leaked markup is repaired, the redraft is accepted', async () => {
    const h = await makeHarness({
      registry: registryWithRealMaintenanceSchema(),
      script: scriptByAgent({
        orchestrator: [
          step('Delegating.', call('delegate', { role: 'maintenance', brief: 'Assess door 1R.' })),
          step('Done.', call('report', ORCH_REPORT)),
        ],
        maintenance: [
          step('Paging.', call('page_engineer', { engineerId: 'eng-1', station: 'MAN' }, 'tu_page')),
          step('Reporting.', replay(EMPTY)),
          step('Reporting.', replay(LEAK_1)),
          step('Redrafting.', replay(LEAK_SHORT)),
        ],
      }),
    });
    const provider = h.deps.providers!.scripted as ReturnType<typeof createScriptedProvider>;
    await h.run();
    const events = await h.events();
    const second = provider.calls.find((c) => c.info.role === 'maintenance' && c.info.iteration === 2)!;
    const err = toolResults(second.req.messages.at(-1))[0]!;
    expect(err.isError).toBe(true);
    expect(err.content).toMatch(/received keys: \(none\)/);
    expect(err.content).toMatch(/missing required: summary, openIssues, recommendations, citations/);

    const leakCall = ofType(events, 'agent.tool_call').find((e) => e.payload.toolCallId === LEAK_1.id)!;
    expect(leakCall.payload.argsRepaired).toEqual(['actionsTaken']);
    expect(Array.isArray(leakCall.payload.args.actionsTaken)).toBe(true);
    // With actionsTaken recovered, the recorded report gets past the schema; its "AOG" wording is then caught by
    // the (unchanged) status-claim screen and redrafted.
    const third = provider.calls.find((c) => c.info.role === 'maintenance' && c.info.iteration === 3)!;
    const screened = toolResults(third.req.messages.at(-1))[0]!;
    expect(screened.content).toMatch(/output screening/);
    expect(screened.content).not.toMatch(/actionsTaken/);

    const report = ofType(events, 'agent.report').find((e) => e.payload.role === 'maintenance')!;
    expect(report.payload.report.composedByRuntime).toBeUndefined();
    expect(report.payload.report.summary).toMatch(/^AX-PMC/);
    expect(report.payload.report.summary).not.toMatch(/parameter/);
    expect(report.payload.report.actionsTaken[0]).toBe('Checked aircraft status and open defects');
    expect(report.payload.report.extras).toBeUndefined();
    // No maintenance call after the accepted report.
    expect(provider.calls.filter((c) => c.info.role === 'maintenance')).toHaveLength(4);
  });

  it('keeps unknown keys under extras and fills actionsTaken from executed tool calls', async () => {
    const h = await makeHarness({
      registry: registryWithRealMaintenanceSchema(),
      script: scriptByAgent({
        orchestrator: [
          step('Delegating.', call('delegate', { role: 'maintenance', brief: 'Assess the door.' })),
          step('Done.', call('report', ORCH_REPORT)),
        ],
        maintenance: [
          step('Paging.', call('page_engineer', { engineerId: 'eng-1', station: 'MAN' }, 'tu_page')),
          step(
            'Reporting.',
            call('report', {
              summary: 'Door frame damage needs a B1 structural inspection before any decision.',
              openIssues: ['Structural inspection not yet done'],
              recommendations: [],
              citations: [],
              provisionalReading: { text: 'Consistent with frame damage.', unconfirmed: true },
              engineerEtaMinute: 12,
              shiftLead: 'Night shift lead informed',
              doorPosition: '1R',
            }),
          ),
        ],
      }),
    });
    await h.run();
    const report = ofType(await h.events(), 'agent.report').find((e) => e.payload.role === 'maintenance')!;
    const r = report.payload.report as Record<string, unknown> & typeof report.payload.report;
    expect(r.extras).toEqual({ shiftLead: 'Night shift lead informed', doorPosition: '1R' });
    expect(r.shiftLead).toBeUndefined();
    expect(r.engineerEtaMinute).toBe(12);
    expect(r.actionsTaken).toHaveLength(1);
    expect(r.actionsTaken[0]).toMatch(/^page_engineer \(eng-1/);
  });

  it('refuses the recorded placeholder report and asks for what was actually done', async () => {
    const h = await makeHarness({
      registry: registryWithRealMaintenanceSchema(),
      script: scriptByAgent({
        orchestrator: [
          step('Delegating.', call('delegate', { role: 'maintenance', brief: 'Assess the door.' })),
          step('Done.', call('report', ORCH_REPORT)),
        ],
        maintenance: [step('Reporting.', replay(PLACEHOLDER)), step('Reporting.', replay(LEAK_SHORT))],
      }),
    });
    const provider = h.deps.providers!.scripted as ReturnType<typeof createScriptedProvider>;
    await h.run();
    const events = await h.events();
    const second = provider.calls.find((c) => c.info.role === 'maintenance' && c.info.iteration === 1)!;
    const err = toolResults(second.req.messages.at(-1))[0]!;
    expect(err.isError).toBe(true);
    expect(err.content).toMatch(/placeholder content is not allowed; report what you actually did/);
    const res = ofType(events, 'agent.tool_result').find((e) => e.payload.toolCallId === PLACEHOLDER.id)!;
    expect(res.payload.ok).toBe(false);
    const report = ofType(events, 'agent.report').find((e) => e.payload.role === 'maintenance')!;
    expect(report.payload.report.summary).toMatch(/^AX-PMC/);
    expect(report.payload.report.actionsTaken).toContain('Paged B1 Tamsin Pennick MAN, ETA 275');
  });

  it('composes the report itself after 3 failed attempts (no model-invented report)', async () => {
    const steps: ScriptStep[] = [
      step('Paging.', call('page_engineer', { engineerId: 'eng-1', station: 'MAN' }, 'tu_page')),
      step('Reporting.', replay(EMPTY)),
      step('Reporting.', call('report', { ...ORCH_REPORT, summary: 'TBD', openIssues: 'none' })),
      step('Reporting.', {
        ...replay(PLACEHOLDER),
        input: { ...PLACEHOLDER.input, recommendations: ['Test recommendation', 'Keep the pax informed'] },
      }),
      step('Should never be asked.', call('report', { ...ORCH_REPORT })),
    ];
    const h = await makeHarness({
      registry: registryWithRealMaintenanceSchema(),
      script: scriptByAgent({
        orchestrator: [
          step('Delegating.', call('delegate', { role: 'maintenance', brief: 'Assess the door.' }, 'tu_del')),
          step('Done.', call('report', ORCH_REPORT)),
        ],
        maintenance: steps,
      }),
    });
    const provider = h.deps.providers!.scripted as ReturnType<typeof createScriptedProvider>;
    await h.run();
    const events = await h.events();
    expect(provider.calls.filter((c) => c.info.role === 'maintenance')).toHaveLength(4);
    const report = ofType(events, 'agent.report').find((e) => e.payload.role === 'maintenance')!;
    const r = report.payload.report;
    expect(r.composedByRuntime).toBe(true);
    expect(r.summary).toMatch(/runtime composed this report/);
    expect(r.actionsTaken).toHaveLength(1);
    expect(r.actionsTaken[0]).toMatch(/^page_engineer/);
    expect(r.recommendations).toEqual(['Keep the pax informed']);
    expect(r.openIssues.at(-1)).toMatch(/rejected 3 times; this report was composed by the runtime/);
    // The orchestrator receives it as the delegate result.
    const delegateResult = ofType(events, 'agent.tool_result').find(
      (e: RunEvent<'agent.tool_result'>) => e.payload.toolCallId === 'tu_del',
    )!;
    expect(delegateResult.payload.ok).toBe(true);
    expect((delegateResult.payload.result as { composedByRuntime?: boolean }).composedByRuntime).toBe(true);
  });
});
