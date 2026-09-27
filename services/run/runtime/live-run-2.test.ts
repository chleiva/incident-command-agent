/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Regressions from the second live run (airborne medical diversion ACX170, AX-NNH). Scripted provider only.
 */
import {
  AgentReportSchema,
  DEFAULT_RUN_LIMITS,
  EVAL_RUN_LIMITS,
  foldEvents,
  validateEvent,
  type Scenario,
} from '@ica/schema';
import { getPublicScenario } from '@ica/scenarios';
import { describe, expect, it } from 'vitest';
import { TRUNCATION_SUFFIX, lenientArgs } from '../guardrails/validate';
import { STOP_MARGIN_MS } from '../handler';
import { call, scriptByAgent, step, type ScriptStep, type createScriptedProvider } from '../llm/scripted';
import { TIMELINE_TEXT_MAX, splitTimelineText } from '../tools/append_timeline';
import { makeHarness, ofType } from './__fixtures__/harness';
import { repairLeakedParameters, type ArgsSchemaView } from './call-repair';
import { defaultRegistry } from './registry';

const REPORT_SCHEMA = AgentReportSchema as unknown as ArgsSchemaView;
const CITATION = {
  sourceId: 'EU261-art-9',
  url: 'https://eur-lex.europa.eu/eli/reg/2004/261/oj',
  title: 'Regulation (EC) No 261/2004, Article 9',
  quote: 'Passengers shall be offered free of charge meals and refreshments',
  chunkId: 'eu261-art9',
};

describe('live run 2, bug A: loop-safety limits, not a shared run cap', () => {
  it('defaults: no run-level tool-call cap, 60 per agent, 25 iterations per agent, 14-min wall clock', () => {
    expect(DEFAULT_RUN_LIMITS).toMatchObject({
      maxToolCallsPerRun: 0,
      maxToolCallsPerAgent: 60,
      maxIterationsPerAgent: 25,
      wallClockMs: 14 * 60_000,
      budgetUsd: 0,
      maxInputTokensPerRun: 0,
    });
    // The eval harness keeps its own caps.
    expect(EVAL_RUN_LIMITS).toMatchObject({
      maxToolCallsPerRun: 40,
      maxIterationsPerAgent: 12,
      budgetUsd: 2,
    });
  });

  it("the handler's graceful stop (< 60 s of Lambda time left) fires before the wall clock", () => {
    const LAMBDA_TIMEOUT_MS = 15 * 60_000;
    // The run's wall clock starts after the Lambda does, so the handler's guard is reached first.
    expect(DEFAULT_RUN_LIMITS.wallClockMs).toBeLessThanOrEqual(LAMBDA_TIMEOUT_MS - STOP_MARGIN_MS);
  });

  it('many agents together may exceed 60 tool calls in one run', async () => {
    const busy = (n: number) =>
      Array.from({ length: n }, (_, i) =>
        step(`Step ${i}.`, call('open_incident', { title: 't', summary: 's' })),
      );
    const report = {
      summary: 'Done: incident opened and followed.',
      openIssues: [],
      recommendations: [],
      citations: [],
    };
    const h = await makeHarness({
      script: scriptByAgent({
        orchestrator: [
          step(
            'Delegating.',
            call('delegate', { role: 'maintenance', brief: 'Work.' }),
            call('delegate', { role: 'ground', brief: 'Work.' }),
            call('delegate', { role: 'passenger', brief: 'Work.' }),
          ),
          step('Done.', call('report', report)),
        ],
        maintenance: [...busy(22), step('R', call('report', report))],
        ground: [...busy(22), step('R', call('report', report))],
        passenger: [...busy(22), step('R', call('report', report))],
      }),
    });
    const r = await h.run();
    const events = await h.events();
    expect(ofType(events, 'agent.aborted')).toEqual([]);
    expect(r.totals!.toolCalls).toBeGreaterThan(60);
    expect(ofType(events, 'agent.report')).toHaveLength(4);
  });
});

describe('live run 2, bug C: leaked argument markup (any tool, any tag form)', () => {
  const RECS = ['Hold AX-NNH at NTE until certifying staff inspect it'];
  it('repairs the exact live shape: `…</summary> <openIssues>[…]` inside summary', () => {
    const input = {
      summary:
        'Crew legality checked for the NTE diversion; no crew-side infeasibility was found.</summary> <openIssues>["Confirm hotel capacity at NTE for 172 passengers", "Positioning crew for the return sector not yet assigned"] ',
      recommendations: RECS,
      citations: [CITATION],
    };
    const { input: out, repaired } = repairLeakedParameters(input, REPORT_SCHEMA);
    expect(repaired).toEqual(['openIssues']);
    expect(out.summary).toBe(
      'Crew legality checked for the NTE diversion; no crew-side infeasibility was found.',
    );
    expect(out.openIssues).toEqual([
      'Confirm hotel capacity at NTE for 172 passengers',
      'Positioning crew for the return sector not yet assigned',
    ]);
    expect(out.recommendations).toBe(RECS);
    expect(out.citations).toEqual([CITATION]);
  });

  it('never overwrites a key the model already provided validly; replaces an invalid one', () => {
    const input = {
      summary:
        'Summary text.</summary>\n<openIssues>["a"]</openIssues>\n<recommendations>["leaked"]</recommendations>',
      recommendations: RECS,
      citations: [],
    };
    const { input: out, repaired } = repairLeakedParameters(input, REPORT_SCHEMA);
    expect(repaired).toEqual(['openIssues']);
    expect(out.recommendations).toBe(RECS);
    expect(out.summary).toBe('Summary text.');
    const invalid = repairLeakedParameters(
      { summary: 'S.</summary><openIssues>["b"]', openIssues: 'none', recommendations: [], citations: [] },
      REPORT_SCHEMA,
    );
    expect(invalid.repaired).toEqual(['openIssues']);
    expect(invalid.input.openIssues).toEqual(['b']);
  });

  it('handles the older `</parameter><parameter name="k">` shape and trailing junk after JSON', () => {
    const { input: out, repaired } = repairLeakedParameters(
      {
        summary:
          'Old shape.</parameter>\n<parameter name="openIssues">["x", "y"] </parameter>\n<parameter name="recommendations">["r"]',
        citations: [],
      },
      REPORT_SCHEMA,
    );
    expect(repaired).toEqual(['openIssues', 'recommendations']);
    expect(out).toMatchObject({ summary: 'Old shape.', openIssues: ['x', 'y'], recommendations: ['r'] });
    // without a schema the old shape is still repaired
    expect(repairLeakedParameters({ summary: 'A.</parameter><parameter name="k">[1]' }).input).toEqual({
      summary: 'A.',
      k: [1],
    });
  });

  it('works for any tool: strings stay strings, numbers are parsed', () => {
    const schema: ArgsSchemaView = {
      properties: { text: { type: 'string' }, atMinute: { type: 'number' }, source: { type: 'string' } },
    };
    const { input: out, repaired } = repairLeakedParameters(
      { text: 'Diverted to NTE.</text> <atMinute>42</atMinute> <source>flightops</source>' },
      schema,
    );
    expect(repaired).toEqual(['atMinute', 'source']);
    expect(out).toEqual({ text: 'Diverted to NTE.', atMinute: 42, source: 'flightops' });
  });

  it('leaves free text with unrelated tags alone and strips a lone trailing closing tag', () => {
    const txt = {
      summary: 'Use the <b>spare</b> aircraft.',
      openIssues: [],
      recommendations: [],
      citations: [],
    };
    expect(repairLeakedParameters(txt, REPORT_SCHEMA)).toEqual({ input: txt, repaired: [] });
    expect(
      repairLeakedParameters({ summary: 'Clean.</summary>', openIssues: [] }, REPORT_SCHEMA).input.summary,
    ).toBe('Clean.');
  });

  it('end to end: the leaked report is accepted first time with argsRepaired recorded', async () => {
    const leaked = {
      summary:
        'Crew legality checked; no crew-side infeasibility was found.</summary> <openIssues>["Positioning crew not yet assigned", "Hotel capacity at NTE"] ',
      recommendations: RECS,
      citations: [],
    };
    const h = await makeHarness({
      script: scriptByAgent({
        orchestrator: [
          step('Delegating.', call('delegate', { role: 'flightops', brief: 'Check crew legality.' })),
          step('Done.', call('report', { ...leaked, summary: 'Coordinated the diversion.', openIssues: [] })),
        ],
        flightops: [step('Reporting.', call('report', leaked, 'tu_leak'))],
      }),
    });
    await h.run();
    const events = await h.events();
    for (const e of events) expect(validateEvent(e).ok).toBe(true);
    const tc = ofType(events, 'agent.tool_call').find((e) => e.payload.toolCallId === 'tu_leak')!;
    expect(tc.payload.argsRepaired).toEqual(['openIssues']);
    const report = ofType(events, 'agent.report').find((e) => e.payload.role === 'flightops')!;
    expect(report.payload.report.openIssues).toEqual([
      'Positioning crew not yet assigned',
      'Hotel capacity at NTE',
    ]);
    expect(report.payload.report.summary).not.toMatch(/openIssues|<\//);
    expect(ofType(events, 'guardrail.blocked')).toEqual([]);
  });
});

describe('live run 2, bug D: free-text length caps and leniency', () => {
  const S01 = getPublicScenario('s01-pushback-tug-contact') as Scenario;
  const REPORT = {
    summary: 'Timeline kept for the incident.',
    openIssues: [],
    recommendations: [],
    citations: [],
  };
  /** A 560-character timeline entry, like the one rejected live (400-char cap). */
  const ENTRY_560 = (
    'Minute 42: ACX170 (AX-NNH) diverted to NTE for a medical emergency; the commander declared the diversion and ' +
    'requested medical assistance on arrival. OCC notified the NTE station, the handler confirmed a remote stand ' +
    'with stairs and an ambulance at the aircraft on arrival. Crew duty remains within limits for the return ' +
    'sector per the crew system; maintenance notes the aircraft status flag in M&E is unchanged. Passenger care ' +
    'at NTE is being prepared for 172 passengers pending the commander decision on continuation, with a hotel ' +
    'block on hold and meal vouchers drafted.'
  )
    .padEnd(560, '.')
    .slice(0, 560);

  async function runRecord(...steps: ScriptStep[]) {
    const h = await makeHarness({
      scenario: S01,
      registry: defaultRegistry(),
      script: scriptByAgent({
        orchestrator: [
          step('Record.', call('delegate', { role: 'record', brief: 'Keep the timeline.' })),
          step('Done.', call('report', REPORT)),
        ],
        record: [...steps, step('Report.', call('report', REPORT))],
      }),
    });
    await h.run();
    const events = await h.events();
    for (const e of events) expect(validateEvent(e).ok).toBe(true);
    return events;
  }

  it('the 560-character timeline entry is accepted as one entry (cap now 2,000)', async () => {
    expect(ENTRY_560).toHaveLength(560);
    const events = await runRecord(
      step('Log.', call('append_timeline', { text: ENTRY_560, atMinute: 42, source: 'record' }, 'tu_tl')),
    );
    expect(ofType(events, 'guardrail.blocked')).toEqual([]);
    const res = ofType(events, 'agent.tool_result').find((e) => e.payload.toolCallId === 'tu_tl')!;
    expect(res.payload.ok).toBe(true);
    const tc = ofType(events, 'agent.tool_call').find((e) => e.payload.toolCallId === 'tu_tl')!;
    expect(tc.payload.argsTruncated).toBeUndefined();
    const timeline = Object.values(foldEvents(events).systems.record.timeline);
    expect(timeline.filter((t) => t.text === ENTRY_560)).toHaveLength(1);
  });

  it('an over-cap timeline entry is split into sequential entries, never truncated', async () => {
    const long = Array.from(
      { length: 60 },
      (_, i) => `Update ${i}: stand, crew and care status checked.`,
    ).join(' ');
    expect(long.length).toBeGreaterThan(TIMELINE_TEXT_MAX);
    const events = await runRecord(step('Log.', call('append_timeline', { text: long }, 'tu_long')));
    expect(ofType(events, 'guardrail.blocked')).toEqual([]);
    const res = ofType(events, 'agent.tool_result').find((e) => e.payload.toolCallId === 'tu_long')!;
    expect(res.payload.ok).toBe(true);
    const parts = Object.values(foldEvents(events).systems.record.timeline).filter((t) =>
      /^\(\d\/\d\) /.test(t.text),
    );
    expect(parts.length).toBe(splitTimelineText(long, TIMELINE_TEXT_MAX).length);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.text.length).toBeLessThanOrEqual(TIMELINE_TEXT_MAX);
    expect(parts.map((p) => p.text.replace(/^\(\d\/\d\) /, '')).join(' ')).toBe(long);
    expect((res.payload.result as { note: string }).note).toMatch(/sequential entries/);
  });

  it('a length-only failure on another free-text field is accepted truncated, recorded and explained', async () => {
    const h = await makeHarness({
      script: scriptByAgent({
        orchestrator: [
          step(
            'Open.',
            call('open_incident', { title: 'Medical diversion', summary: 'x'.repeat(2500) }, 'tu_open'),
          ),
          step('Done.', call('report', REPORT)),
        ],
      }),
    });
    const provider = h.deps.providers!.scripted as ReturnType<typeof createScriptedProvider>;
    await h.run();
    const events = await h.events();
    for (const e of events) expect(validateEvent(e).ok).toBe(true);
    expect(ofType(events, 'guardrail.blocked')).toEqual([]);
    const tc = ofType(events, 'agent.tool_call').find((e) => e.payload.toolCallId === 'tu_open')!;
    expect(tc.payload.argsTruncated).toEqual(['/summary']);
    const summary = tc.payload.args.summary as string;
    expect(summary).toHaveLength(2000);
    expect(summary.endsWith(TRUNCATION_SUFFIX)).toBe(true);
    const next = provider.calls.find((c) => c.info.role === 'orchestrator' && c.info.iteration === 1)!;
    expect(JSON.stringify(next.req.messages.at(-1))).toMatch(/truncated at the length cap/);
  });

  it('non-length errors still reject (even alongside an over-cap field)', async () => {
    const events = await runRecord(
      step('Log.', call('append_timeline', { text: 'y'.repeat(2500), source: 'bogus' }, 'tu_bad')),
    );
    const blocked = ofType(events, 'guardrail.blocked').find((e) => e.payload.toolCallId === 'tu_bad')!;
    expect(blocked.payload.layer).toBe('arg_validation');
    expect(blocked.payload.reason).toMatch(/allowed values/);
  });

  it('lenientArgs: structured strings (ids, patterns, short caps) are never truncated', () => {
    const tool = {
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', maxLength: 48, pattern: '^[A-Za-z0-9-]+$' },
          code: { type: 'string', maxLength: 20 },
          note: { type: 'string', maxLength: 200 },
        },
      },
    };
    expect(lenientArgs(tool, { id: 'a'.repeat(60) })).toBeNull();
    expect(lenientArgs(tool, { code: 'b'.repeat(30) })).toBeNull();
    expect(lenientArgs(tool, { note: 'ok' })).toBeNull();
    const r = lenientArgs(tool, { note: 'n'.repeat(300), code: 'c' })!;
    expect(r.truncated).toEqual(['/note']);
    expect((r.args.note as string).length).toBe(200);
    expect(r.args.code).toBe('c');
  });
});
