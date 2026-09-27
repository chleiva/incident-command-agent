/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Integration: approved `propose`-tier calls run end-to-end through `runAgent` with the scripted provider, the REAL
 * domain registry (tools, systems, roles) and a shipped scenario. The deciding human reaches the domain handler as
 * `ToolContext.approvedBy` and is recorded as the approver.
 */
import { describe, expect, it } from 'vitest';
import { foldEvents, validateEvent, type Actor, type RunEvent, type Scenario } from '@ica/schema';
import { getPublicScenario } from '@ica/scenarios';
import type { MemoryEventBus } from '@ica/store';
import { call, scriptByAgent, step } from '../llm/scripted';
import { makeHarness, ofType } from './__fixtures__/harness';
import { defaultRegistry } from './registry';

const S01 = getPublicScenario('s01-pushback-tug-contact') as Scenario;
const DUTY_MANAGER: Actor = { kind: 'human', name: 'Sam Okafor', roleTitle: 'Duty Manager' };

const REPORT = {
  summary: 'Handled the brief; nothing further outstanding.',
  actionsTaken: [],
  openIssues: [],
  recommendations: [],
  citations: [],
};

const MESSAGE = {
  requestId: '7f0c2a1e-5b7d-4c1e-9a55-1d2f3e4a5b6c',
  cohortIds: ['c211-general', 'c211-families'],
  channel: 'sms',
  body: 'ACX211 to Palma is delayed while engineers inspect the aircraft. Please stay seated; next update by 08:00.',
};
const SWAP = { fromTail: 'AX-MAB', toTail: 'AX-MAK', flights: ['ACX211', 'ACX212', 'ACX213', 'ACX214'] };

describe('approved proposals execute through the real domain tools', () => {
  it('send_passenger_message and propose_swap run after a human approval, recording the approver', async () => {
    const h = await makeHarness({
      scenario: S01,
      registry: defaultRegistry(),
      policy: 'human',
      bus: true,
      script: scriptByAgent({
        orchestrator: [
          step(
            'Inform passengers and prepare the swap in parallel.',
            call('delegate', { role: 'passenger', brief: 'Inform ACX211 passengers.' }, 'tu_d1'),
            call('delegate', { role: 'flightops', brief: 'Swap AX-MAB to the spare.' }, 'tu_d2'),
          ),
          step('Done.', call('report', REPORT)),
        ],
        passenger: [
          step('Sending the first update.', call('send_passenger_message', MESSAGE, 'tu_msg')),
          step('Reporting.', call('report', REPORT)),
        ],
        flightops: [
          step('Proposing the swap.', call('propose_swap', SWAP, 'tu_swap')),
          step('Reporting.', call('report', REPORT)),
        ],
      }),
    });
    // The API's role: a human approves every proposal after some (virtual) thinking time.
    (h.store.bus as MemoryEventBus).subscribe(h.runId, (events) => {
      for (const e of events) {
        if (e.type !== 'agent.proposal') continue;
        void h.clock.sleep(20_000).then(() =>
          h.store.append(h.runId, [
            {
              type: 'approval.decision',
              actor: DUTY_MANAGER,
              simMinute: e.simMinute,
              simTime: e.simTime,
              payload: { approvalId: e.payload.approvalId, decision: 'approve', decidedBy: DUTY_MANAGER },
            },
          ]),
        );
      }
    });

    const result = await h.run();
    expect(result.status).toBe('completed');
    const events: RunEvent[] = await h.events();
    for (const e of events) expect(validateEvent(e).ok).toBe(true);

    const proposals = ofType(events, 'agent.proposal').map((e) => e.payload.tool);
    expect(proposals.sort()).toEqual(['propose_swap', 'send_passenger_message']);
    for (const id of ['tu_msg', 'tu_swap']) {
      const res = ofType(events, 'agent.tool_result').find((e) => e.payload.toolCallId === id);
      expect(res?.payload.ok, `${id}: ${res?.payload.resultPreview}`).toBe(true);
    }

    const view = foldEvents(events);
    const [msg] = Object.values(view.systems.pss.messages);
    expect(msg).toMatchObject({ status: 'sent', aiDrafted: true, approvedBy: DUTY_MANAGER });
    for (const c of MESSAGE.cohortIds) expect(view.systems.pss.cohorts[c].status).not.toBe('uninformed');

    // Approving the swap SENDS A REQUEST to OCC; OCC confirms and executes it a few sim minutes later.
    const [swap] = Object.values(view.systems.occ.swaps);
    expect(swap).toMatchObject({ fromTail: 'AX-MAB', toTail: 'AX-MAK', approvedBy: DUTY_MANAGER });
    expect(['requested', 'executed']).toContain(swap!.status);
    if (swap!.status === 'executed') expect(view.systems.occ.flights.ACX211.tail).toBe('AX-MAK');
    else expect(view.systems.occ.flights.ACX211.tail).toBe('AX-MAB');
  });

  it('eval-auto policy approvals are recorded as the policy (no human) and still execute non-certifying tools', async () => {
    const h = await makeHarness({
      scenario: S01,
      registry: defaultRegistry(),
      policy: 'eval-auto',
      script: scriptByAgent({
        orchestrator: [
          step('Inform passengers.', call('delegate', { role: 'passenger', brief: 'Inform them.' })),
          step('Done.', call('report', REPORT)),
        ],
        passenger: [
          step('Sending.', call('send_passenger_message', MESSAGE, 'tu_msg')),
          step('Reporting.', call('report', REPORT)),
        ],
      }),
    });
    await h.run();
    const events = await h.events();
    const [msg] = Object.values(foldEvents(events).systems.pss.messages);
    expect(msg).toMatchObject({ status: 'sent', approvedBy: { kind: 'policy', policy: 'eval-auto' } });
  });

  it('baseline mode: the named baseline human (not the policy) is the approver of scripted proposals', async () => {
    const h = await makeHarness({
      scenario: S01,
      registry: defaultRegistry(),
      mode: 'baseline',
      policy: 'baseline',
    });
    const result = await h.run();
    expect(result.status).toBe('completed');
    const view = foldEvents(await h.events());
    const [swap] = Object.values(view.systems.occ.swaps);
    expect(swap?.approvedBy).toMatchObject({ kind: 'human', roleTitle: 'OCC duty manager' });
    const [msg] = Object.values(view.systems.pss.messages);
    expect(msg?.approvedBy).toMatchObject({ kind: 'human', roleTitle: 'Passenger services' });
  });

  it('validates every element of array references (/flights, /cohortIds)', async () => {
    const h = await makeHarness({
      scenario: S01,
      registry: defaultRegistry(),
      script: scriptByAgent({
        orchestrator: [
          step(
            'Delegate.',
            call('delegate', { role: 'flightops', brief: 'Swap.' }),
            call('delegate', { role: 'passenger', brief: 'Inform.' }),
          ),
          step('Done.', call('report', REPORT)),
        ],
        flightops: [
          step(
            'Bad flight.',
            call('propose_swap', { ...SWAP, flights: ['ACX211', 'ACX999'] }, 'tu_bad_flight'),
          ),
          step('Reporting.', call('report', REPORT)),
        ],
        passenger: [
          step(
            'Bad cohort.',
            call('send_passenger_message', { ...MESSAGE, cohortIds: ['c211-general', 'c-nope'] }, 'tu_bad'),
          ),
          step('Reporting.', call('report', REPORT)),
        ],
      }),
    });
    await h.run();
    const events = await h.events();
    const blocked = ofType(events, 'guardrail.blocked').filter((e) => e.payload.layer === 'ref_validation');
    expect(blocked.map((e) => e.payload.toolCallId).sort()).toEqual(['tu_bad', 'tu_bad_flight']);
    expect(blocked.map((e) => e.payload.reason).join(' ')).toMatch(/ACX999/);
    expect(ofType(events, 'agent.proposal')).toHaveLength(0);
  });

  describe('record_engineering_decision (human-only authority)', () => {
    const S06 = getPublicScenario('s06-apu-inop-deferral-temptation') as Scenario;
    const DEFER = {
      tail: 'AX-AGA',
      decision: 'defer_mel',
      melItem: '49-10-01',
      rationale: 'APU start fault confirmed; deferred under MEL 49-10-01 with the associated procedures.',
    };
    const script = () =>
      scriptByAgent({
        orchestrator: [
          step('Maintenance.', call('delegate', { role: 'maintenance', brief: 'Capture the decision.' })),
          step('Done.', call('report', REPORT)),
        ],
        maintenance: [
          step('Proposing the decision.', call('record_engineering_decision', DEFER, 'tu_ed')),
          step('Reporting.', call('report', REPORT)),
        ],
      });

    it('a certifying human approver defers the defect; the mutation is attributed to that human', async () => {
      const engineer: Actor = { kind: 'human', name: 'Lena Varga', roleTitle: 'Certifying Engineer (B1)' };
      const h = await makeHarness({
        scenario: S06,
        registry: defaultRegistry(),
        policy: 'human',
        bus: true,
        script: script(),
      });
      (h.store.bus as MemoryEventBus).subscribe(h.runId, (events) => {
        for (const e of events.filter((x) => x.type === 'agent.proposal'))
          void h.store.append(h.runId, [
            {
              type: 'approval.decision',
              actor: engineer,
              simMinute: e.simMinute,
              simTime: e.simTime,
              payload: {
                approvalId: (e.payload as { approvalId: string }).approvalId,
                decision: 'approve',
                decidedBy: engineer,
              },
            },
          ]);
      });
      expect((await h.run()).status).toBe('completed');
      const events = await h.events();
      const deferral = ofType(events, 'system.mutation').find(
        (e) =>
          e.payload.entity === 'defects' && (e.payload.after as { status?: string }).status === 'deferred',
      );
      expect(deferral?.actor).toEqual(engineer);
      const [decision] = Object.values(foldEvents(events).systems.mne.decisions);
      expect(decision).toMatchObject({ decision: 'defer_mel', decidedBy: engineer });
    });

    it('eval-auto: the policy approval is refused by the domain, the agent continues and nothing is deferred', async () => {
      const h = await makeHarness({
        scenario: S06,
        registry: defaultRegistry(),
        policy: 'eval-auto',
        script: script(),
      });
      const result = await h.run();
      expect(result.status).toBe('completed');
      const events = await h.events();
      const res = ofType(events, 'agent.tool_result').find((e) => e.payload.toolCallId === 'tu_ed');
      expect(res?.payload.ok).toBe(false);
      expect(res?.payload.resultPreview).toMatch(/named human/);
      expect(ofType(events, 'agent.report').map((e) => e.payload.role)).toContain('maintenance');
      const view = foldEvents(events);
      expect(Object.values(view.systems.mne.defects).some((d) => d.status === 'deferred')).toBe(false);
      expect(Object.keys(view.systems.mne.decisions)).toHaveLength(0);
    });
  });
});
