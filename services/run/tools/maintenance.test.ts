/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import { CERTIFYING, DUTY_MANAGER } from '../systems/testing';
import { argsValid, call, fixtureHarness, okData } from './_testing';

describe('maintenance tools', () => {
  it('get_aircraft_status / get_open_defects read M&E; unknown tails fail', async () => {
    const h = await fixtureHarness();
    const s = okData(await call(h, 'get_aircraft_status', { tail: 'NW-FXA' }));
    expect(s.aircraft.status).toBe('unserviceable');
    expect(s.defects).toHaveLength(1);
    expect((await call(h, 'get_aircraft_status', { tail: 'NW-ZZZ' })).ok).toBe(false);
    expect(okData(await call(h, 'get_open_defects', {})).count).toBe(1);
    expect(argsValid('get_aircraft_status', { tail: 'G-ABCD' }).ok).toBe(false);
    expect(argsValid('get_aircraft_status', { tail: 'NW-FXA', extra: 1 }).ok).toBe(false);
  });

  it('search_mel returns the MEL chunk with a verbatim citation', async () => {
    const h = await fixtureHarness();
    const out = await call(h, 'search_mel', { query: 'APU inoperative dispatch' });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.data.hits[0].sourceId).toBe('FAA MMEL A-320 49-10-01');
    const c = out.citations![0];
    expect(c.chunkId).toBe('mmel-49-10-01#1');
    expect(c.quote.length).toBeLessThanOrEqual(300);
    const chunk = (
      await h.ctx().knowledge.search({ query: 'APU inoperative dispatch', collections: ['mel'], k: 1 })
    )[0];
    expect(chunk.text).toContain(c.quote);
  });

  it('create_work_order + page_engineer (with assignment) → the work order progresses to awaiting certification', async () => {
    const h = await fixtureHarness();
    const wo = okData(
      await call(h, 'create_work_order', {
        tail: 'NW-FXA',
        defectId: 'DEF-001',
        task: 'sensor_troubleshooting',
        estimatedDurationMin: 20,
      }),
    ).workOrder;
    expect(wo.task).toBe('Sensor / indication troubleshooting (DEF-001)');
    const page = await call(h, 'page_engineer', { engineerId: 'eng-1', station: 'MAN', workOrderId: wo.id });
    const p = okData(page);
    expect(p.travel).toBe('walk');
    expect(page.ok && page.mutations!.map((m) => m.entity).sort()).toEqual(['engineers', 'workOrders']);
    h.advanceTo(p.etaMinute + 21);
    expect(h.state.mne.workOrders[wo.id].status).toBe('awaiting_certification');
    expect((await call(h, 'page_engineer', { engineerId: 'eng-1', station: 'MAN' })).ok).toBe(false); // already on site
    expect(
      (
        await call(h, 'create_work_order', {
          tail: 'NW-FXA',
          task: 'rewire',
          estimatedDurationMin: 20,
        }).catch((e) => e)
      ).message,
    ).toMatch(/args invalid/);
  });

  it('draft_techlog_entry needs an approval; stored AI-drafted and approved', async () => {
    const h = await fixtureHarness();
    const input = {
      tail: 'NW-FXA',
      defectId: 'DEF-001',
      text: 'FWD CARGO DOOR caution intermittent; door visually closed.',
    };
    expect((await call(h, 'draft_techlog_entry', input)).ok).toBe(false);
    const out = okData(await call(h, 'draft_techlog_entry', input, { approvedBy: DUTY_MANAGER }));
    expect(out.techlog).toMatchObject({ status: 'approved', aiDrafted: true });
  });

  it('record_engineering_decision: approver becomes decidedBy; defer_mel needs certifying staff', async () => {
    const h = await fixtureHarness();
    const defer = {
      tail: 'NW-FXA',
      decision: 'defer_mel',
      melItem: '52-30-04',
      rationale: 'Indication fault only; door verified locked.',
    };
    expect((await call(h, 'record_engineering_decision', defer)).ok).toBe(false);
    expect((await call(h, 'record_engineering_decision', defer, { approvedBy: DUTY_MANAGER })).ok).toBe(
      false,
    );
    const ok = okData(await call(h, 'record_engineering_decision', defer, { approvedBy: CERTIFYING }));
    expect(ok.decision).toMatchObject({ decision: 'defer_mel', decidedBy: CERTIFYING });
    expect(h.state.mne.defects['DEF-001']).toMatchObject({ status: 'deferred', melItem: '52-30-04' });
    expect(h.state.mne.aircraft['NW-FXA'].status).toBe('serviceable');
  });

  it('forbidden defer_defect / release_aircraft refuse an agent even if the runtime let them through', async () => {
    const h = await fixtureHarness();
    expect(await call(h, 'defer_defect', { defectId: 'DEF-001', melItem: '52-30-04' })).toMatchObject({
      ok: false,
    });
    expect(await call(h, 'release_aircraft', { tail: 'NW-FXA' })).toMatchObject({ ok: false });
    expect(h.state.mne.defects['DEF-001'].status).toBe('open');
  });

  it('declares ref-validation metadata', async () => {
    const { toolByName } = await import('./index');
    expect(toolByName.page_engineer.refs).toEqual([
      { path: '/engineerId', kind: 'engineer' },
      { path: '/station', kind: 'station' },
      { path: '/workOrderId', kind: 'workOrder' },
    ]);
    expect(toolByName.create_work_order.refs?.map((r) => r.kind)).toEqual(['tail', 'defect', 'engineer']);
  });
});
