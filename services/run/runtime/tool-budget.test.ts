/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Tool budget (demo review 2026-09-27: Flight Ops called get_crew_fdp 14× in one turn and repeated get_rotation /
 * find_spare_aircraft): identical calls in one model turn run once; read-only results are cached per agent run until
 * mock state changes; neither counts against the per-agent tool cap, and both stay visible in the events.
 */
import { describe, expect, it } from 'vitest';
import { validateEvent, type RunEvent } from '@ica/schema';
import { call, scriptByAgent, step } from '../llm/scripted';
import { get_crew_fdp } from '../tools/get_crew_fdp';
import { find_standby_crew } from '../tools/find_standby_crew';
import { harness as systemsHarness } from '../systems/testing';
import { canonicalArgs } from './execute';
import { makeHarness, ofType } from './__fixtures__/harness';
import { defaultRegistry } from './registry';

const REPORT = {
  summary: 'Crew and rotation checked; nothing further outstanding.',
  actionsTaken: [],
  openIssues: [],
  recommendations: [],
  citations: [],
};

const viaFlightops = (steps: ReturnType<typeof step>[]) =>
  scriptByAgent({
    orchestrator: [
      step('Delegating.', call('delegate', { role: 'flightops', brief: 'Check crew and rotation.' })),
      step('Done.', call('report', REPORT)),
    ],
    flightops: steps,
  });

const calls = (events: RunEvent[], tool: string) =>
  ofType(events, 'agent.tool_call').filter((e) => e.payload.tool === tool);
const results = (events: RunEvent[], tool: string) =>
  ofType(events, 'agent.tool_result').filter((e) => e.payload.tool === tool);

describe('tool budget: same-turn dedupe and the read-only cache', () => {
  it('canonical args ignore key order and undefined values', () => {
    expect(canonicalArgs({ b: 1, a: { d: 2, c: [1, { y: 1, x: 2 }] }, u: undefined })).toBe(
      canonicalArgs({ a: { c: [1, { x: 2, y: 1 }], d: 2 }, b: 1 }),
    );
  });

  it('identical calls in one turn execute once; the duplicates get the same result and are marked', async () => {
    const h = await makeHarness({
      registry: defaultRegistry(),
      limits: { maxToolCallsPerAgent: 3 },
      script: viaFlightops([
        step(
          'Checking every crew member.',
          call('get_crew_fdp', { crewId: 'crew-cpt-1' }, 'tu_f1'),
          call('get_crew_fdp', { crewId: 'crew-cpt-1' }, 'tu_f2'),
          call('get_crew_fdp', { crewId: 'crew-cpt-1' }, 'tu_f3'),
          call('get_crew_fdp', { crewId: 'crew-cpt-1' }, 'tu_f4'),
          call('get_crew_fdp', { crewId: 'crew-fo-1' }, 'tu_f5'),
        ),
        step('Reporting.', call('report', REPORT)),
      ]),
    });
    const result = await h.run();
    expect(result.status).toBe('completed');
    const events = await h.events();
    for (const e of events) expect(validateEvent(e).ok).toBe(true);
    const c = calls(events, 'get_crew_fdp');
    expect(c).toHaveLength(5);
    expect(c.filter((e) => e.payload.deduplicatedFrom === 'tu_f1').map((e) => e.payload.toolCallId)).toEqual([
      'tu_f2',
      'tu_f3',
      'tu_f4',
    ]);
    const r = results(events, 'get_crew_fdp');
    const first = r.find((e) => e.payload.toolCallId === 'tu_f1')!;
    for (const id of ['tu_f2', 'tu_f3', 'tu_f4']) {
      const dup = r.find((e) => e.payload.toolCallId === id)!;
      expect(dup.payload).toMatchObject({
        ok: true,
        deduplicatedFrom: 'tu_f1',
        result: first.payload.result,
      });
    }
    // flightops ran 2 reads + its report = 3 calls: the per-agent cap of 3 was never breached.
    expect(ofType(events, 'agent.aborted')).toHaveLength(0);
    // orchestrator delegate + report, flightops 2 real reads + report: the 3 duplicates are not counted
    expect(result.totals?.toolCalls).toBe(5);
  });

  it('a repeated read in a later turn is served from the cache until mock state changes', async () => {
    const h = await makeHarness({
      registry: defaultRegistry(),
      script: viaFlightops([
        step('Rotation.', call('get_rotation', { tail: 'AX-FXA' }, 'tu_r1')),
        step('Again.', call('get_rotation', { tail: 'AX-FXA' }, 'tu_r2')),
        step('Different args run.', call('get_rotation', {}, 'tu_r3')),
        step('Reporting.', call('report', REPORT)),
      ]),
    });
    await h.run();
    const events = await h.events();
    const c = calls(events, 'get_rotation');
    expect(c.find((e) => e.payload.toolCallId === 'tu_r2')?.payload.cachedFrom).toBe('tu_r1');
    expect(c.find((e) => e.payload.toolCallId === 'tu_r3')?.payload.cachedFrom).toBeUndefined();
    const r2 = results(events, 'get_rotation').find((e) => e.payload.toolCallId === 'tu_r2')!;
    const r1 = results(events, 'get_rotation').find((e) => e.payload.toolCallId === 'tu_r1')!;
    expect(r2.payload).toMatchObject({ ok: true, cachedFrom: 'tu_r1', result: r1.payload.result });
  });

  it('a mutation of mock state invalidates the cache', async () => {
    const h = await makeHarness({
      registry: defaultRegistry(),
      script: scriptByAgent({
        orchestrator: [
          step('Delegating.', call('delegate', { role: 'maintenance', brief: 'Check the aircraft.' })),
          step('Done.', call('report', REPORT)),
        ],
        maintenance: [
          step('Status.', call('get_aircraft_status', { tail: 'AX-FXA' }, 'tu_s1')),
          step(
            'Page.',
            call(
              'page_engineer',
              { engineerId: 'eng-1', station: 'MAN', requestId: '0b8e2f3a-1c2d-4e5f-8a9b-0c1d2e3f4a5b' },
              'tu_p',
            ),
          ),
          step('Status again.', call('get_aircraft_status', { tail: 'AX-FXA' }, 'tu_s2')),
          step('Reporting.', call('report', REPORT)),
        ],
      }),
    });
    await h.run();
    const events = await h.events();
    const s2 = calls(events, 'get_aircraft_status').find((e) => e.payload.toolCallId === 'tu_s2');
    expect(s2?.payload.cachedFrom).toBeUndefined();
  });
});

describe('crew-level reads (one call instead of one per crew member)', () => {
  it('get_crew_fdp without crewId returns every operating and standby member, at-risk first', async () => {
    const h = systemsHarness();
    const out = await h.call(get_crew_fdp, {});
    expect(out.ok).toBe(true);
    const data = (out as { data: Record<string, any> }).data;
    expect(data.crew.map((m: { id: string }) => m.id).sort()).toEqual([
      'crew-cpt-1',
      'crew-cpt-sby',
      'crew-fo-1',
    ]);
    expect(data.standby.map((m: { id: string }) => m.id)).toEqual(['crew-cpt-sby']);
    expect(Array.isArray(data.atRisk)).toBe(true);
    expect(data.note).toMatch(/no need to call get_crew_fdp per crew member/);
  });

  it('find_standby_crew without replacesCrewId lists every at-risk member with candidates, plus the roster', async () => {
    const h = systemsHarness();
    h.state.crew.crew['crew-cpt-1'] = { ...h.state.crew.crew['crew-cpt-1']!, maxFdpMin: 1 };
    const out = await h.call(find_standby_crew, { flight: 'ACX101' });
    expect(out.ok).toBe(true);
    const data = (out as { data: Record<string, any> }).data;
    expect(data.standby.map((m: { id: string }) => m.id)).toEqual(['crew-cpt-sby']);
    const rep = data.replacements.find((r: { replacesCrewId: string }) => r.replacesCrewId === 'crew-cpt-1');
    expect(rep).toBeDefined();
    expect(rep.candidates.map((c: { id: string }) => c.id)).toEqual(['crew-cpt-sby']);
    // the single-member form still works
    const one = await h.call(find_standby_crew, { replacesCrewId: 'crew-cpt-1', flight: 'ACX101' });
    expect(one.ok).toBe(true);
  });
});
