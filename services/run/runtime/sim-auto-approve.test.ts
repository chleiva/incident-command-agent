/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * The simulation safety net (human policy): an approval still pending after `simAutoApproveAfterMs` of real time is
 * approved as `{kind:'policy', policy:'simulation-auto'}` through the conditional decide path, so it never
 * double-decides with a person or the browser's countdown. Fake (virtual) clock throughout.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SIM_AUTO_APPROVE_AFTER_MS,
  foldEvents,
  simAutoApproveAfterMsFromEnv,
  validateEvent,
  type Actor,
  type RunEvent,
  type Scenario,
} from '@ica/schema';
import { getPublicScenario } from '@ica/scenarios';
import type { MemoryEventBus } from '@ica/store';
import { call, scriptByAgent, step } from '../llm/scripted';
import { makeHarness, ofType, type Harness } from './__fixtures__/harness';
import { defaultRegistry } from './registry';

const S01 = getPublicScenario('s01-pushback-tug-contact') as Scenario;
const DUTY_MANAGER: Actor = { kind: 'human', name: 'Sam Okafor', roleTitle: 'Duty Manager' };
const SIM_AUTO: Actor = { kind: 'policy', policy: 'simulation-auto' };

const REPORT = {
  summary: 'Handled the brief; nothing further outstanding.',
  actionsTaken: [],
  openIssues: [],
  recommendations: [],
  citations: [],
};
const MESSAGE = {
  requestId: '7f0c2a1e-5b7d-4c1e-9a55-1d2f3e4a5b6c',
  cohortIds: ['c211-general'],
  channel: 'sms',
  body: 'ACX211 to Palma is delayed while engineers inspect the aircraft. Next update by 08:00.',
};

function harness(simAutoApproveAfterMs: number, policy: 'human' | 'eval-auto' = 'human') {
  return makeHarness({
    scenario: S01,
    registry: defaultRegistry(),
    policy,
    bus: true,
    simAutoApproveAfterMs,
    script: scriptByAgent({
      orchestrator: [
        step('Inform passengers.', call('delegate', { role: 'passenger', brief: 'Inform ACX211.' }, 'tu_d1')),
        step('Done.', call('report', REPORT)),
      ],
      passenger: [
        step('Sending the first update.', call('send_passenger_message', MESSAGE, 'tu_msg')),
        step('Reporting.', call('report', REPORT)),
      ],
    }),
  });
}

/** The API's decide path: conditional claim of the ApprovalRecord, then the event (optionally later). */
function decideLikeApi(h: Harness, opts: { claimAfterMs: number; eventAfterMs?: number }) {
  (h.store.bus as MemoryEventBus).subscribe(h.runId, (events) => {
    for (const e of events) {
      if (e.type !== 'agent.proposal') continue;
      const approvalId = e.payload.approvalId;
      void h.clock.sleep(opts.claimAfterMs).then(async () => {
        const claimed = await h.store.decideApproval(h.runId, approvalId, 'pending', { status: 'approved' });
        if (!claimed) return;
        await h.clock.sleep((opts.eventAfterMs ?? opts.claimAfterMs) - opts.claimAfterMs);
        await h.store.append(h.runId, [
          {
            type: 'approval.decision',
            actor: DUTY_MANAGER,
            simMinute: e.simMinute,
            simTime: e.simTime,
            payload: { approvalId, decision: 'approve', decidedBy: DUTY_MANAGER },
          },
        ]);
      });
    }
  });
}

const decisions = (events: RunEvent[]) => ofType(events, 'approval.decision');

describe('simulation safety net (human policy, real-time delay)', () => {
  it('auto-approves a pending approval after the delay, as simulation-auto, and the tool runs', async () => {
    const h = await harness(120_000);
    const result = await h.run();
    expect(result.status).toBe('completed');
    const events = await h.events();
    for (const e of events) expect(validateEvent(e).ok).toBe(true);
    const [proposal] = ofType(events, 'agent.proposal');
    const [decision] = decisions(events);
    expect(decisions(events)).toHaveLength(1);
    expect(decision).toMatchObject({
      actor: SIM_AUTO,
      payload: { approvalId: proposal!.payload.approvalId, decision: 'approve', decidedBy: SIM_AUTO },
    });
    const waited = Date.parse(decision!.wallTime) - Date.parse(proposal!.wallTime);
    expect(waited).toBeGreaterThanOrEqual(120_000);
    expect(waited).toBeLessThan(121_000);
    const rec = await h.store.getApproval(h.runId, proposal!.payload.approvalId);
    expect(rec).toMatchObject({ status: 'approved', decision: { decidedBy: SIM_AUTO, seq: decision!.seq } });
    const res = ofType(events, 'agent.tool_result').find((e) => e.payload.toolCallId === 'tu_msg');
    expect(res?.payload.ok).toBe(true);
    const [msg] = Object.values(foldEvents(events).systems.pss.messages);
    expect(msg).toMatchObject({ status: 'sent', approvedBy: SIM_AUTO });
  });

  it('a person deciding first wins: no simulation decision is written', async () => {
    const h = await harness(120_000);
    decideLikeApi(h, { claimAfterMs: 20_000 });
    await h.run();
    const events = await h.events();
    expect(decisions(events)).toHaveLength(1);
    expect(decisions(events)[0]!.payload.decidedBy).toEqual(DUTY_MANAGER);
  });

  it('cannot double-decide: the browser claimed first, its event lands after the deadline', async () => {
    const h = await harness(120_000);
    // Claimed at 110 s, event written at 130 s: the runtime's claim at 120 s fails and it waits for the event.
    decideLikeApi(h, { claimAfterMs: 110_000, eventAfterMs: 130_000 });
    const result = await h.run();
    expect(result.status).toBe('completed');
    const events = await h.events();
    expect(decisions(events)).toHaveLength(1);
    expect(decisions(events)[0]!.payload.decidedBy).toEqual(DUTY_MANAGER);
    const res = ofType(events, 'agent.tool_result').find((e) => e.payload.toolCallId === 'tu_msg');
    expect(res?.payload.ok).toBe(true);
  });

  it('0 = off: the agent keeps waiting for the person', async () => {
    const h = await harness(0);
    decideLikeApi(h, { claimAfterMs: 600_000 });
    await h.run();
    const events = await h.events();
    expect(decisions(events)).toHaveLength(1);
    expect(decisions(events)[0]!.payload.decidedBy).toEqual(DUTY_MANAGER);
  });

  it('not applied to eval-auto (the eval policy decides at once)', async () => {
    const h = await harness(1_000, 'eval-auto');
    await h.run();
    const events = await h.events();
    expect(decisions(events).map((d) => d.payload.decidedBy)).toEqual([
      { kind: 'policy', policy: 'eval-auto' },
    ]);
  });

  it('reads SIM_AUTO_APPROVE_AFTER_MS (default and invalid → 0 = off for agent runs; the knob stays)', () => {
    expect(simAutoApproveAfterMsFromEnv({})).toBe(DEFAULT_SIM_AUTO_APPROVE_AFTER_MS);
    expect(DEFAULT_SIM_AUTO_APPROVE_AFTER_MS).toBe(0);
    expect(simAutoApproveAfterMsFromEnv({ SIM_AUTO_APPROVE_AFTER_MS: '0' })).toBe(0);
    expect(simAutoApproveAfterMsFromEnv({ SIM_AUTO_APPROVE_AFTER_MS: '30000' })).toBe(30_000);
    expect(simAutoApproveAfterMsFromEnv({ SIM_AUTO_APPROVE_AFTER_MS: 'soon' })).toBe(0);
  });

  it('by default (off) an agent-run approval waits for the person, however long it takes', async () => {
    const h = await harness(simAutoApproveAfterMsFromEnv({}));
    decideLikeApi(h, { claimAfterMs: 600_000 });
    const result = await h.run();
    expect(result.status).toBe('completed');
    const events = await h.events();
    expect(decisions(events).map((d) => d.payload.decidedBy)).toEqual([DUTY_MANAGER]);
  });
});
