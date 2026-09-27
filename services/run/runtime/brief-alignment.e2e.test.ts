/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Integration (task 06): the brief-alignment behaviours end to end through `executeRun`, the REAL domain registry
 * and a shipped scenario, with the scripted provider (no network): the presenter's forbidden-call demonstration
 * goes through the real tier gate; proposals carry provenance and assumptions; an engineer-ETA twist after the first
 * approval invalidates it and the owning agent issues a revised proposal; idempotent retries do nothing twice; the
 * maintenance report never states a status.
 */
import { describe, expect, it } from 'vitest';
import {
  PROVISIONAL_READING_LABEL,
  foldEvents,
  validateEvent,
  type RunEvent,
  type Scenario,
} from '@ica/schema';
import { getPublicScenario } from '@ica/scenarios';
import type { MemoryEventBus } from '@ica/store';
import { call, scriptByAgent, step } from '../llm/scripted';
import { makeHarness, ofType } from './__fixtures__/harness';
import { defaultRegistry } from './registry';

const S01 = getPublicScenario('s01-pushback-tug-contact') as Scenario;
const REPORT = { summary: 'done', actionsTaken: [], openIssues: [], recommendations: [], citations: [] };
const MESSAGE = {
  cohortIds: ['c211-general', 'c211-families'],
  channel: 'sms',
  body: 'NWD211 to Palma is delayed while engineers inspect the aircraft. Please stay seated; next update by 08:00.',
};
const PAGE = { engineerId: 'eng-man-b1a', station: 'MAN', requestId: '0b8f5c1e-9a1d-4f3e-8c2b-6d7e8f9a0b1c' };

function allValid(events: RunEvent[]) {
  for (const e of events) expect(validateEvent(e).ok, `${e.seq} ${e.type}`).toBe(true);
}

describe('task 06: brief alignment (runtime)', () => {
  it('demo_forbidden pushes a presenter-triggered call through the real tier gate and counts it', async () => {
    const h = await makeHarness({
      scenario: S01,
      registry: defaultRegistry(),
      bus: true,
      script: scriptByAgent({
        orchestrator: [
          step('Maintenance first.', call('delegate', { role: 'maintenance', brief: 'Page an engineer.' })),
          step('Done.', call('report', REPORT)),
        ],
        maintenance: [
          step('Paging.', call('page_engineer', PAGE, 'tu_page')),
          step('Checking status.', call('get_aircraft_status', { tail: 'NW-MAB' }, 'tu_status')),
          step('Reporting.', call('report', REPORT)),
        ],
      }),
    });
    // The API's role: the presenter presses "Demonstrate blocked action" once maintenance is working.
    let sent = false;
    (h.store.bus as MemoryEventBus).subscribe(h.runId, (events) => {
      for (const e of events) {
        if (sent || e.type !== 'agent.started' || e.payload.role !== 'maintenance') continue;
        sent = true;
        void h.store.append(h.runId, [
          {
            type: 'control.requested',
            actor: { kind: 'human', name: 'Presenter', roleTitle: 'Duty Manager' },
            simMinute: e.simMinute,
            simTime: e.simTime,
            payload: { action: 'demo_forbidden', tool: 'defer_defect' },
          },
        ]);
      }
    });
    const result = await h.run();
    expect(result.status).toBe('completed');
    const events = await h.events();
    allValid(events);

    const demoCall = ofType(events, 'agent.tool_call').find((e) => e.payload.presenterTriggered);
    expect(demoCall).toBeDefined();
    expect(demoCall!.payload).toMatchObject({ tool: 'defer_defect', tier: 'forbidden' });
    expect(demoCall!.actor).toEqual({ kind: 'agent', role: 'maintenance' });

    const block = ofType(events, 'guardrail.blocked').find(
      (e) => e.payload.toolCallId === demoCall!.payload.toolCallId,
    );
    expect(block?.payload).toMatchObject({
      layer: 'tier',
      tool: 'defer_defect',
      presenterTriggered: true,
      authority: 'Certifying staff',
    });
    expect(block!.payload.rule).toMatch(/certifying-staff decision/);
    // Nothing changed: no defect was deferred.
    const view = foldEvents(events);
    expect(Object.values(view.systems.mne.defects).every((d) => d.status !== 'deferred')).toBe(true);
    // Counted exactly like a real attempt; the "why" says it was presenter-triggered.
    const k = view.kpis!;
    expect(k.safety.value.forbiddenAttempts).toBe(1);
    expect(k.safety.inputs.presenterTriggeredAttempts).toBe(1);
    expect(k.safety.formula).toMatch(/presenter-triggered/);
    expect(k.safety.contributingSeqs).toContain(block!.seq);
    expect(view.guardrailBlocks.at(-1)).toMatchObject({
      presenterTriggered: true,
      authority: 'Certifying staff',
    });
  });

  it('an engineer-ETA twist after the first approval invalidates it; the owning agent re-gathers and revises', async () => {
    const h = await makeHarness({
      scenario: S01,
      registry: defaultRegistry(),
      policy: 'eval-auto',
      script: scriptByAgent({
        orchestrator: [
          step('Engineer first.', call('delegate', { role: 'maintenance', brief: 'Page the B1 on base.' })),
          step('Now passengers.', call('delegate', { role: 'passenger', brief: 'First update to NWD211.' })),
          step('Done.', call('report', REPORT)),
        ],
        maintenance: [
          step('Paging.', call('page_engineer', PAGE, 'tu_page')),
          step('Reporting.', call('report', REPORT)),
        ],
        passenger: [
          step(
            'First update.',
            call(
              'send_passenger_message',
              {
                ...MESSAGE,
                requestId: 'a1b2c3d4-0000-4000-8000-000000000001',
                unresolvedChecks: ['Engineer arrival time not yet confirmed on site'],
              },
              'tu_msg',
            ),
          ),
          step('Reporting.', call('report', REPORT)),
        ],
        'revise/passenger.1': [
          step('Re-gathering.', call('get_manifest_summary', { flight: 'NWD211' }, 'tu_regather')),
          step(
            'Revised update.',
            call(
              'send_passenger_message',
              {
                ...MESSAGE,
                body: 'NWD211 to Palma: the engineer will reach the aircraft later than planned. Please stay seated; next update by 08:30.',
                requestId: 'a1b2c3d4-0000-4000-8000-000000000002',
              },
              'tu_msg2',
            ),
          ),
          step('Reporting.', call('report', REPORT)),
        ],
      }),
    });
    const result = await h.run();
    expect(result.status).toBe('completed');
    const events = await h.events();
    allValid(events);

    // Provenance on the first proposal: runtime fills scope (from the tool), checks, as-of time and assumptions.
    const [first, revised] = ofType(events, 'agent.proposal');
    expect(first!.payload.tool).toBe('send_passenger_message');
    expect(first!.payload.args).not.toHaveProperty('unresolvedChecks');
    expect(first!.payload.unresolvedChecks).toEqual(['Engineer arrival time not yet confirmed on site']);
    expect(first!.payload.approvalScope?.authorises).toMatch(/Sending this exact message/);
    expect(first!.payload.approvalScope?.doesNotAuthorise.length).toBeGreaterThan(0);
    expect(typeof first!.payload.dataAsOfMinute).toBe('number');
    const eta = first!.payload.assumptions?.find((a) => a.key === 'engineerEtaMinute');
    expect(eta).toMatchObject({ source: 'engineers/engineers/eng-man-b1a#etaMinute' });

    // The twist fires only after the first approval.
    const decision = ofType(events, 'approval.decision').find(
      (e) => e.payload.approvalId === first!.payload.approvalId,
    )!;
    const twist = ofType(events, 'world.twist').find((e) => e.payload.twistId === 'tw-engineer-eta')!;
    expect(twist.seq).toBeGreaterThan(decision.seq);

    const inv = ofType(events, 'approval.invalidated')[0]!;
    expect(inv.payload.approvalId).toBe(first!.payload.approvalId);
    expect(inv.payload.affectedAssumptions[0]).toMatchObject({
      key: 'engineerEtaMinute',
      was: eta!.value,
      now: (eta!.value as number) + 40,
    });
    expect(inv.seq).toBeGreaterThan(twist.seq);

    // Re-gathered evidence appears as normal tool calls, then the revised proposal is linked.
    const regather = ofType(events, 'agent.tool_call').find((e) => e.payload.toolCallId === 'tu_regather')!;
    expect(regather.seq).toBeGreaterThan(inv.seq);
    expect(revised!.payload.supersedesApprovalId).toBe(first!.payload.approvalId);
    expect(revised!.seq).toBeGreaterThan(regather.seq);

    const view = foldEvents(events);
    expect(view.approvals[first!.payload.approvalId]!.invalidated?.affectedAssumptions[0]!.key).toBe(
      'engineerEtaMinute',
    );
    expect(view.approvals[first!.payload.approvalId]!.supersededBy).toBe(revised!.payload.approvalId);
    expect(view.approvals[revised!.payload.approvalId]!.supersedesApprovalId).toBe(first!.payload.approvalId);
  });

  it('idempotent retries: the same requestId returns the original result with no new mutation or proposal', async () => {
    const h = await makeHarness({
      scenario: S01,
      registry: defaultRegistry(),
      policy: 'eval-auto',
      script: scriptByAgent({
        orchestrator: [
          step('Engineer.', call('delegate', { role: 'maintenance', brief: 'Page and open the work.' })),
          step('Done.', call('report', REPORT)),
        ],
        maintenance: [
          step('Paging.', call('page_engineer', PAGE, 'tu_page1')),
          step('Retrying the page (timeout).', call('page_engineer', PAGE, 'tu_page2')),
          step(
            'Work order.',
            call(
              'create_work_order',
              {
                tail: 'NW-MAB',
                task: 'damage_assessment',
                estimatedDurationMin: 60,
                requestId: 'wo-req-00000001',
              },
              'tu_wo1',
            ),
            call(
              'create_work_order',
              {
                tail: 'NW-MAB',
                task: 'damage_assessment',
                estimatedDurationMin: 60,
                requestId: 'wo-req-00000001',
              },
              'tu_wo2',
            ),
          ),
          step('Reporting.', call('report', REPORT)),
        ],
      }),
    });
    await h.run();
    const events = await h.events();
    allValid(events);
    const results = ofType(events, 'agent.tool_result');
    const r1 = results.find((e) => e.payload.toolCallId === 'tu_page1')!;
    const r2 = results.find((e) => e.payload.toolCallId === 'tu_page2')!;
    expect(r1.payload.ok).toBe(true);
    expect(r2.payload).toMatchObject({ ok: true, deduplicatedFrom: 'tu_page1' });
    expect(r2.payload.result).toEqual(r1.payload.result);
    const agentEngineerMutations = ofType(events, 'system.mutation').filter(
      (e) => e.actor.kind === 'agent' && e.payload.system === 'engineers',
    );
    expect(agentEngineerMutations).toHaveLength(1);
    expect(
      Object.values(foldEvents(events).systems.mne.workOrders).filter(
        (w) => w.requestId === 'wo-req-00000001',
      ),
    ).toHaveLength(1);
    expect(results.find((e) => e.payload.toolCallId === 'tu_wo2')!.payload.deduplicatedFrom).toBe('tu_wo1');
  });

  it('a maintenance report stating a status is blocked, then accepted with a provisional reading', async () => {
    const h = await makeHarness({
      scenario: S01,
      registry: defaultRegistry(),
      script: scriptByAgent({
        orchestrator: [
          step('Maintenance.', call('delegate', { role: 'maintenance', brief: 'Assess.' })),
          step('Done.', call('report', REPORT)),
        ],
        maintenance: [
          step(
            'Report.',
            call('report', {
              ...REPORT,
              summary: 'The nose-gear damage is non-deferrable; the aircraft is AOG.',
            }),
          ),
          step(
            'Report again.',
            call('report', {
              ...REPORT,
              summary: 'Nose-gear contact; inspection by certifying staff pending.',
              recommendations: ['Keep the spare on standby until the inspection result'],
              provisionalReading: {
                text: 'Possible torque-link damage; needs inspection.',
                confidence: 'low',
                unconfirmed: true,
              },
            }),
          ),
        ],
      }),
    });
    await h.run();
    const events = await h.events();
    allValid(events);
    const blocked = ofType(events, 'guardrail.blocked').find(
      (e) => e.payload.layer === 'output_screen' && e.payload.tool === 'report',
    );
    expect(blocked?.payload.reason).toMatch(/status:deferrable/);
    const report = ofType(events, 'agent.report').find((e) => e.payload.role === 'maintenance')!;
    expect(report.payload.report.summary).not.toMatch(/deferrable|AOG/i);
    expect(report.payload.report.provisionalReading).toMatchObject({ unconfirmed: true });
    // Every recommendation carries provenance (runtime defaults: as-of time, a scope that authorises nothing).
    expect(report.payload.report.recommendationDetails?.[0]).toMatchObject({
      text: 'Keep the spare on standby until the inspection result',
      approvalScope: { authorises: expect.stringMatching(/^Nothing by itself/) },
    });
    expect(typeof report.payload.report.recommendationDetails?.[0]?.dataAsOfMinute).toBe('number');
    expect(PROVISIONAL_READING_LABEL).toBe('Provisional reading — unconfirmed');
  });

  it('after the retries, remaining status claims are redacted, never shown', async () => {
    const bad = { ...REPORT, summary: 'Airworthy after a quick look; deferrable under the MEL.' };
    const h = await makeHarness({
      scenario: S01,
      registry: defaultRegistry(),
      script: scriptByAgent({
        orchestrator: [
          step('Maintenance.', call('delegate', { role: 'maintenance', brief: 'Assess.' })),
          step('Done.', call('report', REPORT)),
        ],
        maintenance: [
          step('1', call('report', bad)),
          step('2', call('report', bad)),
          step('3', call('report', bad)),
        ],
      }),
    });
    await h.run();
    const report = ofType(await h.events(), 'agent.report').find((e) => e.payload.role === 'maintenance')!;
    expect(report.payload.report.summary).not.toMatch(/airworthy|deferrable/i);
    expect(report.payload.report.summary).toMatch(/status for certifying staff to decide/);
  });
});
