/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Task 06 at the tool level: idempotent notification and work-order tools (a repeat `requestId` returns the original
 * result with no new mutation), "Unknown" for missing maintenance data (never a default), approval scopes on every
 * propose-tier tool, and the tech-log status-claim screen.
 */
import { describe, expect, it } from 'vitest';
import { UNKNOWN, type Scenario } from '@ica/schema';
import { screenOutput } from '../guardrails/screen-output';
import { seedMne } from '../systems/mne/index';
import { DUTY_MANAGER, fixtureScenario } from '../systems/testing';
import { call, fixtureHarness, okData } from './_testing';
import { domainTools } from './index';

const REQ = 'c0ffee00-1111-4222-8333-444455556666';

describe('idempotent notification and work-order tools (requestId)', () => {
  it('every notifying tool requires a requestId and declares it as its idempotency key', () => {
    const idempotent = [
      'create_work_order',
      'page_engineer',
      'notify_handler',
      'send_passenger_message',
      'request_bus',
      'request_tow',
      'request_stand',
      'assign_standby_crew',
    ];
    for (const name of idempotent) {
      const t = domainTools.find((x) => x.name === name)!;
      expect(t.idempotencyKey, name).toBe('/requestId');
      expect((t.inputSchema as { required?: string[] }).required, name).toContain('requestId');
    }
  });

  it('create_work_order: a retry returns the original work order and creates nothing', async () => {
    const h = await fixtureHarness();
    const input = { tail: 'NW-FXA', task: 'damage_assessment', estimatedDurationMin: 60, requestId: REQ };
    const first = await call(h, 'create_work_order', input);
    expect(first.ok && first.mutations).toHaveLength(1);
    const retry = await call(h, 'create_work_order', input);
    expect(retry.ok).toBe(true);
    expect(retry.ok && retry.mutations).toBeUndefined();
    expect(okData(retry).workOrder.id).toBe(okData(first).workOrder.id);
    expect(okData(retry).deduplicated).toBe(true);
    expect(Object.values(h.state.mne.workOrders)).toHaveLength(1);
    expect(Object.values(h.state.mne.workOrders)[0]!.requestId).toBe(REQ);
    // A new request id is a new request.
    okData(await call(h, 'create_work_order', { ...input, requestId: 'another-request-1' }));
    expect(Object.values(h.state.mne.workOrders)).toHaveLength(2);
  });

  it('page_engineer: a retry returns the original page instead of failing "already paged"', async () => {
    const h = await fixtureHarness();
    const input = { engineerId: 'eng-1', station: 'MAN', requestId: REQ };
    const first = okData(await call(h, 'page_engineer', input));
    const retry = await call(h, 'page_engineer', input);
    expect(retry.ok && retry.mutations).toBeUndefined();
    expect(okData(retry)).toMatchObject({
      engineerId: 'eng-1',
      etaMinute: first.etaMinute,
      deduplicated: true,
    });
    expect(h.state.engineers.engineers['eng-1']!.pageRequestId).toBe(REQ);
    // A genuinely new page of the same engineer still fails (already paged).
    expect((await call(h, 'page_engineer', { ...input, requestId: 'another-request-2' })).ok).toBe(false);
  });

  it('notify_handler, request_bus, request_tow and request_stand dedupe on requestId', async () => {
    const h = await fixtureHarness();
    for (const [name, input] of [
      ['notify_handler', { kind: 'hold_boarding', tail: 'NW-FXA', requestId: 'handler-req-1' }],
      ['request_bus', { count: 1, tail: 'NW-FXA', requestId: 'bus-req-0001' }],
      ['request_tow', { tail: 'NW-FXA', requestId: 'tow-req-00001' }],
      ['request_stand', { tail: 'NW-FXA', standId: 'R5', requestId: 'stand-req-001' }],
    ] as const) {
      const first = await call(h, name, input);
      expect(first.ok, `${name}: ${!first.ok && first.error}`).toBe(true);
      const before = JSON.stringify(h.state);
      const retry = await call(h, name, input);
      expect(retry.ok && retry.mutations, name).toBeUndefined();
      expect(okData(retry).deduplicated, name).toBe(true);
      expect(JSON.stringify(h.state), name).toBe(before);
    }
  });

  it('send_passenger_message: a retry after approval does not message passengers twice', async () => {
    const h = await fixtureHarness();
    const input = {
      cohortIds: ['c-general'],
      channel: 'sms',
      body: 'NWD101 is delayed while engineers check the aircraft. Next update by 06:45.',
      requestId: REQ,
    };
    const first = okData(await call(h, 'send_passenger_message', input, { approvedBy: DUTY_MANAGER }));
    const retry = await call(h, 'send_passenger_message', input, { approvedBy: DUTY_MANAGER });
    expect(retry.ok && retry.mutations).toBeUndefined();
    expect(okData(retry)).toMatchObject({ messageId: first.messageId, deduplicated: true });
    expect(Object.values(h.state.pss.messages)).toHaveLength(1);
  });

  it('assign_standby_crew: a retry returns the original call-out', async () => {
    const h = await fixtureHarness();
    const input = {
      standbyId: 'crew-cpt-sby',
      replacesCrewId: 'crew-cpt-1',
      flight: 'NWD101',
      requestId: REQ,
    };
    okData(await call(h, 'assign_standby_crew', input, { approvedBy: DUTY_MANAGER }));
    const retry = await call(h, 'assign_standby_crew', input, { approvedBy: DUTY_MANAGER });
    expect(retry.ok && retry.mutations).toBeUndefined();
    expect(okData(retry).assigned.id).toBe('crew-cpt-sby');
  });
});

describe('missing maintenance data is "Unknown" (never a default)', () => {
  const withoutRecord = (): Scenario => {
    const s = fixtureScenario();
    s.trigger.type = 'unlisted-trigger'; // no ATA chapter can be derived
    s.trigger.evidence = [{ kind: 'report', text: 'Crew report, no MEL reference.' }];
    delete (s.aircraft as { maintenance?: unknown }).maintenance;
    return s;
  };

  it('the seed does not invent a record', () => {
    const mne = seedMne(withoutRecord());
    expect(mne.aircraft['NW-FXA']!.maintenance).toBeUndefined();
    expect(mne.aircraft['NW-FXA']!.status).toBe('unserviceable');
    expect(mne.defects['DEF-001']!.ata).toBeUndefined();
  });

  it('get_aircraft_status and get_open_defects show Unknown for every missing field', async () => {
    const h = await fixtureHarness(withoutRecord());
    const s = okData(await call(h, 'get_aircraft_status', { tail: 'NW-FXA' }));
    expect(s.maintenanceRecord).toEqual({
      lastCheckType: UNKNOWN,
      lastCheckDate: UNKNOWN,
      defectHistory: UNKNOWN,
    });
    expect(s.defects[0]).toMatchObject({ ata: UNKNOWN, melItem: UNKNOWN });
    expect(JSON.stringify(s)).not.toMatch(/"(passed|OK)"/);
    const d = okData(await call(h, 'get_open_defects', {}));
    expect(d.defects[0]).toMatchObject({ ata: UNKNOWN, melItem: UNKNOWN });
  });

  it('fields the scenario provides are shown; only the missing ones are Unknown', async () => {
    const s = withoutRecord();
    s.aircraft.maintenance = { lastCheckType: 'A-check', lastCheckDate: '2026-05-30' };
    const h = await fixtureHarness(s);
    const r = okData(await call(h, 'get_aircraft_status', { tail: 'NW-FXA' }));
    expect(r.maintenanceRecord).toEqual({
      lastCheckType: 'A-check',
      lastCheckDate: '2026-05-30',
      defectHistory: UNKNOWN,
    });
  });
});

describe('approval scope on every propose-tier tool', () => {
  it('each propose-tier domain tool states what approving it authorises and does not', () => {
    for (const t of domainTools.filter((x) => x.tier === 'propose')) {
      expect(t.approvalScope, t.name).toMatch(/\w/);
      expect(t.approvalExclusions?.length, t.name).toBeGreaterThan(0);
    }
    const swap = domainTools.find((t) => t.name === 'propose_swap')!;
    expect(swap.approvalScope).toMatch(/Sending this swap request to Operations Control/);
  });
});

describe('status-like claims', () => {
  it('a tech-log draft may not state a status; a factual one passes', () => {
    expect(screenOutput('techlog', 'Nose gear damage, deferrable per MEL.').ok).toBe(false);
    expect(screenOutput('techlog', 'Aircraft AOG awaiting parts.').ok).toBe(false);
    expect(screenOutput('techlog', 'Declared airworthy by the crew.').ok).toBe(false);
    expect(
      screenOutput(
        'techlog',
        'Tug contact with the nose landing gear; inspection by certifying staff pending.',
      ).ok,
    ).toBe(true);
  });
});
