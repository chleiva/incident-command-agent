/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { call, fixtureHarness, okData } from './_testing';

describe('ground tools', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('get_stand_status shows stands, requests, equipment', async () => {
    const h = await fixtureHarness();
    const s = okData(await call(h, 'get_stand_status', {}));
    expect(s.station).toBe('MAN');
    expect(s.stands.find((x: any) => x.id === 'R5').free).toBe(true);
    expect(s.stands.find((x: any) => x.id === '22').free).toBe(false);
    expect(s.equipment.map((e: any) => e.id).sort()).toEqual(['MAN:bus', 'MAN:stairs', 'MAN:tug']);
  });

  it('request_stand creates a pending request; occupied stands are rejected at confirmation', async () => {
    const h = await fixtureHarness();
    const out = await call(h, 'request_stand', { tail: 'AX-FXA', standId: '24' });
    const r = okData(out).standRequest;
    expect(out.ok && out.mutations).toHaveLength(1);
    h.advanceTo(r.confirmAtMinute);
    expect(h.state.airport.standRequests[r.id].status).toBe('rejected');
    expect((await call(h, 'request_stand', { tail: 'AX-FXA', standId: 'NOPE' })).ok).toBe(false);
  });

  it('request_tow takes a tug and can request the destination stand; fails when no tug is left', async () => {
    const h = await fixtureHarness();
    const t = okData(await call(h, 'request_tow', { tail: 'AX-FXA', toStandId: 'R5' }));
    expect(t.tow).toMatchObject({ kind: 'tow', status: 'confirmed', station: 'MAN' });
    expect(t.standRequest.standId).toBe('R5');
    expect(h.state.handler.equipment['MAN:tug'].available).toBe(1);
    okData(await call(h, 'request_tow', { tail: 'AX-FXB' }));
    expect(await call(h, 'request_tow', { tail: 'AX-FXA' })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/no tug/),
    });
  });

  it('request_bus books several buses and refuses beyond the pool', async () => {
    const h = await fixtureHarness();
    expect(okData(await call(h, 'request_bus', { count: 2 })).buses).toHaveLength(2);
    expect((await call(h, 'request_bus', { count: 1 })).ok).toBe(false);
  });

  it('notify_handler composes the task note from structured fields (no free text)', async () => {
    const h = await fixtureHarness();
    const t = okData(
      await call(h, 'notify_handler', { kind: 'hold_boarding', tail: 'AX-FXA', priority: 'urgent' }),
    ).task;
    expect(t.note).toBe('Stop boarding and hold passengers at the gate for AX-FXA — URGENT');
    expect(t.ackAtMinute).toBeGreaterThanOrEqual(1);
    h.advanceTo(t.ackAtMinute);
    expect(h.state.handler.tasks[t.id].status).toBe('acknowledged');
  });

  it('search_procedure returns procedure/rules chunks with citations, jurisdiction-filtered', async () => {
    const h = await fixtureHarness();
    const out = await call(
      h,
      'search_procedure',
      { query: 'tug driver clearance pushback', jurisdiction: 'UK' },
      { role: 'ground' },
    );
    expect(out.ok && out.citations!.length).toBeGreaterThan(0);
    if (out.ok) for (const hit of out.data.hits as any[]) expect(hit.jurisdiction ?? 'UK').toBe('UK');
  });

  it('get_weather returns the scenario snapshot (live weather off in tests)', async () => {
    vi.stubEnv('FEATURE_LIVE_WEATHER', 'false');
    const h = await fixtureHarness();
    const w = okData(await call(h, 'get_weather', {}));
    expect(w.snapshot).toMatchObject({ station: 'MAN', windKt: 12 });
    expect((await call(h, 'get_weather', { station: 'CDG' })).ok).toBe(false);
  });
});
