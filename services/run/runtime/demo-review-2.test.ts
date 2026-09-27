/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Regressions from the second live demo review (run-20260927-224750-2zcd8s: ground vehicle strike on AX-ZZD at PMI,
 * built from ACX125). Scripted provider only: the exact inputs the model sent live.
 */
import { validateEvent, type RunEvent } from '@ica/schema';
import { generateDaySchedule } from '@ica/network';
import { buildScenarioFromFlight } from '@ica/network/templates';
import { describe, expect, it } from 'vitest';
import { TRUNCATION_SUFFIX, isFreeText, lenientArgs } from '../guardrails/validate';
import { call, scriptByAgent, step, type ScriptStep } from '../llm/scripted';
import { PAGE_REASON_MAX, page_engineer } from '../tools/page_engineer';
import { makeHarness, ofType } from './__fixtures__/harness';
import { coerceDecisionArgs, repairCall } from './call-repair';
import { defaultRegistry } from './registry';
import { ORCHESTRATOR_RUNTIME_TOOLS, requestDecisionTool } from './tools';

const schedule = generateDaySchedule('accent-air', '2026-09-27');
/** The live scenario: ACX125 at the gate at PMI (in-block 09:25Z), the turnaround for ACX126. */
const SCENARIO = buildScenarioFromFlight(schedule, 'ACX125', 'vehicle_strike', {
  atMs: Date.parse('2026-09-27T09:30:00Z'),
}).scenario;

const REPORT = {
  summary: 'Done: engineer cover arranged for the door inspection.',
  openIssues: [],
  recommendations: [],
  citations: [],
};

/** The reason the model wrote live (≈100 characters; the cap was 60). */
const LIVE_REASON =
  'backup - MAN B1 ETA 275min via positioning flight is too slow; IBZ B1 available from minute 90 likely faster';

async function runMaintenance(...steps: ScriptStep[]) {
  const h = await makeHarness({
    scenario: SCENARIO,
    registry: defaultRegistry(),
    script: scriptByAgent({
      orchestrator: [
        step('Maintenance.', call('delegate', { role: 'maintenance', brief: 'Get a B1 to the aircraft.' })),
        step('Done.', call('report', REPORT)),
      ],
      maintenance: [...steps, step('Report.', call('report', REPORT))],
    }),
  });
  await h.run();
  const events = await h.events();
  for (const e of events) expect(validateEvent(e).ok, JSON.stringify(validateEvent(e))).toBe(true);
  return events;
}

const resultOf = (events: RunEvent[], id: string) =>
  ofType(events, 'agent.tool_result').find((e) => e.payload.toolCallId === id)!;

describe('demo review 2 — item 1: page_engineer', () => {
  it('the live scenario has the live roster (MAN B1 by air, IBZ B1 busy until minute 90, PMI B2)', () => {
    const roster = SCENARIO.world.engineers.map((e) => [e.id, e.licence, e.station, e.availableFromMinute]);
    expect(roster).toEqual(
      expect.arrayContaining([
        ['eng-ibz-b1', 'B1', 'IBZ', 90],
        ['eng-pmi-b2', 'B2', 'PMI', 0],
      ]),
    );
    expect(
      roster.some(([id, lic, st]) => /^eng-man-b1/.test(String(id)) && lic === 'B1' && st === 'MAN'),
    ).toBe(true);
  });

  it('reason accepts the live ≈100-character sentence (cap 500); a longer one is truncated, never rejected', () => {
    const reason = (page_engineer.inputSchema as { properties: { reason: { maxLength: number } } }).properties
      .reason;
    expect(reason.maxLength).toBe(PAGE_REASON_MAX);
    expect(PAGE_REASON_MAX).toBe(500);
    expect(LIVE_REASON.length).toBeGreaterThan(60);
    const args = {
      engineerId: 'eng-ibz-b1',
      station: 'PMI',
      requestId: 'c3d4e5f6-a7b8-4901',
      reason: LIVE_REASON,
    };
    expect(lenientArgs(page_engineer, args)).toBeNull(); // valid as sent
    const long = lenientArgs(page_engineer, { ...args, reason: LIVE_REASON.repeat(6) })!;
    expect(long.truncated).toEqual(['/reason']);
    expect((long.args.reason as string).length).toBe(500);
    expect((long.args.reason as string).endsWith(TRUNCATION_SUFFIX)).toBe(true);
  });

  it('every free-text field of every tool is length-lenient (no pattern/enum/format = free text, any cap)', () => {
    const tools = [...defaultRegistry().tools, ...ORCHESTRATOR_RUNTIME_TOOLS];
    let checked = 0;
    for (const t of tools) {
      const props =
        (t.inputSchema as { properties?: Record<string, Record<string, unknown>> }).properties ?? {};
      for (const [k, node] of Object.entries(props)) {
        if (node.type !== 'string' || typeof node.maxLength !== 'number') continue;
        const structured = node.pattern !== undefined || node.enum !== undefined || node.format !== undefined;
        expect(isFreeText(node), `${t.name}/${k}`).toBe(!structured);
        if (structured) continue;
        // A lone over-cap value on this field (other required fields aside) is only ever a maxLength error.
        const r = lenientArgs(
          { inputSchema: { type: 'object', properties: { [k]: node } } },
          {
            [k]: 'x'.repeat((node.maxLength as number) + 50),
          },
        )!;
        expect(r.truncated, `${t.name}/${k}`).toEqual([`/${k}`]);
        expect((r.args[k] as string).length).toBeLessThanOrEqual(node.maxLength as number);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(15);
    // Short caps too (e.g. lookup_airport /query ≤ 60): a bare ellipsis marks the cut.
    const short = lenientArgs(
      { inputSchema: { type: 'object', properties: { q: { type: 'string', maxLength: 10 } } } },
      {
        q: 'Palma de Mallorca airport',
      },
    )!;
    expect(short.args.q).toBe('Palma de…');
  });

  it('the live sequence: the long reason is accepted, the busy IBZ engineer is not paged, alternatives are listed, and the immediate retry is refused', async () => {
    const man = SCENARIO.world.engineers.find((e) => /^eng-man-b1/.test(e.id))!;
    const events = await runMaintenance(
      step(
        'Page the MAN B1.',
        call(
          'page_engineer',
          { engineerId: man.id, station: 'PMI', requestId: 'b2c3d4e5-f6a7-4890-b123' },
          'tu_p1',
        ),
      ),
      step(
        'Page IBZ as backup.',
        call(
          'page_engineer',
          {
            engineerId: 'eng-ibz-b1',
            station: 'PMI',
            reason: LIVE_REASON,
            requestId: 'c3d4e5f6-a7b8-4901-c234',
          },
          'tu_p2',
        ),
      ),
      step(
        'Try IBZ again.',
        call(
          'page_engineer',
          {
            engineerId: 'eng-ibz-b1',
            station: 'PMI',
            reason: 'backup: faster B1 path than MAN',
            requestId: 'b7e1a2f0-3c4d-4e5f',
          },
          'tu_p3',
        ),
      ),
    );
    // No arg-validation block at all (the live run had two).
    expect(ofType(events, 'guardrail.blocked')).toEqual([]);
    expect(resultOf(events, 'tu_p1').payload.ok).toBe(true);

    const busy = resultOf(events, 'tu_p2').payload;
    expect(busy.ok).toBe(false);
    expect(busy.resultPreview).toMatch(
      /Fern Marshwood \(eng-ibz-b1\) is busy until minute 90; nothing was sent/,
    );
    const detail = busy.result as {
      notPaged: boolean;
      name: string;
      reason: string;
      busyUntilMinute: number;
      alternatives: {
        engineerId: string;
        name: string;
        licence: string;
        station: string;
        etaMinuteEstimate: number;
        whySuitable: string;
      }[];
    };
    expect(detail).toMatchObject({
      notPaged: true,
      name: 'Fern Marshwood',
      reason: 'busy',
      busyUntilMinute: 90,
    });
    expect(detail.alternatives.length).toBeGreaterThan(0);
    expect(detail.alternatives.map((a) => a.engineerId)).not.toContain('eng-ibz-b1');
    for (const a of detail.alternatives) {
      expect(a.name).toBeTruthy();
      expect(a.licence).toMatch(/^B[12]$/);
      expect(a.station).toMatch(/^[A-Z]{3}$/);
      expect(a.etaMinuteEstimate).toBeGreaterThanOrEqual(0);
      expect(a.whySuitable).toMatch(/B[12]:/);
    }

    const retry = resultOf(events, 'tu_p3').payload;
    expect(retry.ok).toBe(false);
    expect(retry.resultPreview).toMatch(
      /Not sent again: Fern Marshwood \(eng-ibz-b1\) was already tried at minute/,
    );
    expect((retry.result as { retryRefused: boolean }).retryRefused).toBe(true);

    // Neither failed page changed anything: the only engineer mutations belong to the first page.
    const engineerMutations = ofType(events, 'system.mutation').filter(
      (e) => e.payload.system === 'engineers' && e.payload.op === 'update' && e.payload.id === 'eng-ibz-b1',
    );
    expect(engineerMutations).toEqual([]);
  });
});

describe('demo review 2 — item 2: request_decision recommendation', () => {
  const metrics = (t: number) => ({
    timeToDepartureMin: t,
    costEur: 0,
    customerImpact: 40,
    compliant: true,
    constraints: [],
  });
  /** The live shape: top-level recommendedOptionId, per-option `recommended` only on some options. */
  const LIVE = {
    question: 'Door 1R on AX-ZZD: wait for a B1, swap to the spare, or cancel?',
    recommendedOptionId: 'swap-axsaa',
    options: [
      { id: 'wait-repair', label: 'Wait for the B1 engineer', metrics: metrics(275) },
      { id: 'swap-axsaa', label: 'Swap to AX-SAA', metrics: metrics(150), recommended: true },
      { id: 'cancel', label: 'Cancel ACX126', metrics: metrics(0) },
    ],
  };

  it('derives per-option `recommended` from recommendedOptionId (and back); none → nothing recommended', () => {
    const a = coerceDecisionArgs(LIVE);
    expect((a.input.options as { recommended: boolean }[]).map((o) => o.recommended)).toEqual([
      false,
      true,
      false,
    ]);
    expect(a.repaired).toEqual(['/options/0/recommended', '/options/2/recommended']);

    const onlyFlags = coerceDecisionArgs({
      ...LIVE,
      recommendedOptionId: undefined,
      options: LIVE.options.map((o) => ({ ...o, recommended: o.id === 'cancel' })),
    });
    expect(onlyFlags.input.recommendedOptionId).toBe('cancel');

    const topOnly = coerceDecisionArgs({
      ...LIVE,
      options: LIVE.options.map(({ recommended: _r, ...o }) => o),
    });
    expect((topOnly.input.options as { recommended: boolean }[]).map((o) => o.recommended)).toEqual([
      false,
      true,
      false,
    ]);

    const none = coerceDecisionArgs({
      question: 'q',
      options: LIVE.options.map(({ recommended: _r, ...o }) => o),
    });
    expect((none.input.options as { recommended: boolean }[]).every((o) => o.recommended === false)).toBe(
      true,
    );
    expect('recommendedOptionId' in none.input).toBe(false);

    const unknownId = coerceDecisionArgs({ ...LIVE, recommendedOptionId: 'nope' });
    expect(unknownId.input.recommendedOptionId).toBe('swap-axsaa');

    // Missing constraints and numeric strings in the metrics are coerced too.
    const loose = coerceDecisionArgs({
      question: 'q',
      options: [
        {
          id: 'a',
          label: 'A',
          metrics: { timeToDepartureMin: '45', costEur: 0, customerImpact: 10, compliant: true },
        },
        { id: 'b', label: 'B', metrics: metrics(90) },
      ],
    });
    const m0 = (loose.input.options as { metrics: Record<string, unknown> }[])[0]!.metrics;
    expect(m0).toMatchObject({ timeToDepartureMin: 45, constraints: [] });
  });

  it('the tool schema no longer requires the redundant fields', () => {
    const s = requestDecisionTool.inputSchema as {
      required: string[];
      properties: {
        options: { items: { required: string[]; properties: { metrics: { required: string[] } } } };
      };
    };
    expect(s.required).not.toContain('recommendedOptionId');
    expect(s.properties.options.items.required).not.toContain('recommended');
    expect(s.properties.options.items.properties.metrics.required).not.toContain('constraints');
  });

  it('repairCall applies the coercion and records it as argsRepaired', () => {
    const c = repairCall({ id: 'tu', name: 'request_decision', input: LIVE }, [], () => true);
    expect(c.argsRepaired).toEqual(['/options/0/recommended', '/options/2/recommended']);
  });

  it('end to end: the live call (top-level id only on two options) is accepted, not rejected', async () => {
    const h = await makeHarness({
      scenario: SCENARIO,
      registry: defaultRegistry(),
      script: scriptByAgent({
        orchestrator: [
          step('Decide.', call('request_decision', LIVE, 'tu_rd')),
          step('Done.', call('report', REPORT)),
        ],
      }),
    });
    await h.run();
    const events = await h.events();
    for (const e of events) expect(validateEvent(e).ok).toBe(true);
    expect(ofType(events, 'guardrail.blocked')).toEqual([]);
    const proposal = ofType(events, 'agent.proposal').find((e) => e.payload.toolCallId === 'tu_rd')!;
    expect(proposal.payload.options!.map((o) => o.recommended)).toEqual([false, true, false]);
    expect(resultOf(events, 'tu_rd').payload.ok).toBe(true);
    const tc = ofType(events, 'agent.tool_call').find((e) => e.payload.toolCallId === 'tu_rd')!;
    expect(tc.payload.argsRepaired).toEqual(['/options/0/recommended', '/options/2/recommended']);
  });
});
