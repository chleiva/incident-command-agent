/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import { DUTY_MANAGER, fixtureScenario } from '../systems/testing';
import { OCC_CONFIRM_MIN } from '../systems/occ/index';
import { call, fixtureHarness, okData } from './_testing';

describe('flight-ops tools', () => {
  it('get_rotation lists flights with ETD/delay and curfew conflicts', async () => {
    const s = fixtureScenario();
    s.world.curfews = [{ station: 'MAN', fromLocal: '09:30', toLocal: '10:30' }];
    const h = await fixtureHarness(s);
    const r = okData(await call(h, 'get_rotation', {}));
    expect(r.flights.map((f: any) => f.flight)).toEqual(['ACX101', 'ACX102']);
    expect(r.flights[1].curfewConflict).toMatch(/ETA .* inside the MAN curfew/);
  });

  it('find_spare_aircraft evaluates each spare for the rest of the rotation', async () => {
    const h = await fixtureHarness();
    const r = okData(await call(h, 'find_spare_aircraft', { flight: 'ACX101' }));
    expect(r.flights).toEqual(['ACX101', 'ACX102']);
    expect(r.candidates[0]).toMatchObject({ tail: 'AX-FXB', feasible: true, onTime: false, delayMin: 40 });
  });

  it('propose_swap: approval sends a request to OCC; OCC confirms and executes it in its tick', async () => {
    const h = await fixtureHarness();
    const input = { fromTail: 'AX-FXA', toTail: 'AX-FXB', flights: ['ACX101', 'ACX102'] };
    expect((await call(h, 'propose_swap', input)).ok).toBe(false);
    const out = okData(await call(h, 'propose_swap', input, { approvedBy: DUTY_MANAGER }));
    // Approving sends the request; nothing is re-tailed yet.
    expect(out.swap.status).toBe('requested');
    expect(out.note).toMatch(/request sent to OCC/);
    expect(h.state.occ.flights.ACX101.tail).toBe('AX-FXA');
    const [requested] = Object.values(h.state.occ.swaps);
    expect(requested).toMatchObject({ status: 'requested', approvedBy: DUTY_MANAGER });
    expect(requested!.confirmAtMinute).toBe(h.simMinute + OCC_CONFIRM_MIN);
    // OCC confirms through its modelled process.
    h.advanceTo(h.simMinute + OCC_CONFIRM_MIN + 1);
    const [executed] = Object.values(h.state.occ.swaps);
    expect(executed).toMatchObject({ status: 'executed', approvedBy: DUTY_MANAGER });
    expect(executed!.occNote).toMatch(/Confirmed and executed by OCC/);
    expect(h.state.occ.flights.ACX101.tail).toBe('AX-FXB');
    expect(h.state.occ.spares['AX-FXB'].assignedTo).toBe('ACX101,ACX102');
    expect((await call(h, 'propose_swap', input, { approvedBy: DUTY_MANAGER })).ok).toBe(false); // spare used
  });

  it('OCC refuses a swap request that is no longer feasible at confirmation', async () => {
    const h = await fixtureHarness();
    const input = { fromTail: 'AX-FXA', toTail: 'AX-FXB', flights: ['ACX101', 'ACX102'] };
    okData(await call(h, 'propose_swap', input, { approvedBy: DUTY_MANAGER }));
    // Something else takes the spare before OCC confirms.
    h.state.occ.spares['AX-FXB'].assignedTo = 'ACX999';
    h.advanceTo(h.simMinute + OCC_CONFIRM_MIN + 1);
    const [swap] = Object.values(h.state.occ.swaps);
    expect(swap).toMatchObject({ status: 'rejected' });
    expect(swap!.occNote).toMatch(/OCC could not execute/);
    expect(h.state.occ.flights.ACX101.tail).toBe('AX-FXA');
  });

  it('propose_cancel cancels the flight and the downstream leg', async () => {
    const h = await fixtureHarness();
    const r = okData(await call(h, 'propose_cancel', { flight: 'ACX101' }, { approvedBy: DUTY_MANAGER }));
    expect(r.alsoCancelled).toEqual(['ACX102']);
    expect(h.state.occ.flights.ACX102.status).toBe('cancelled');
  });

  it('get_crew_fdp and find_standby_crew / assign_standby_crew', async () => {
    const h = await fixtureHarness();
    const fdp = okData(await call(h, 'get_crew_fdp', { crewId: 'crew-cpt-1' }));
    expect(fdp.crew[0]).toMatchObject({ fdpUsedMin: 20, fdpMarginMin: 440, sectors: ['ACX101', 'ACX102'] });
    const sb = okData(await call(h, 'find_standby_crew', { replacesCrewId: 'crew-cpt-1', flight: 'ACX101' }));
    expect(sb.candidates[0]).toMatchObject({ id: 'crew-cpt-sby', feasible: true });
    const fo = okData(await call(h, 'find_standby_crew', { replacesCrewId: 'crew-fo-1', flight: 'ACX101' }));
    expect(fo.feasibleCount).toBe(0);
    const input = { standbyId: 'crew-cpt-sby', replacesCrewId: 'crew-cpt-1', flight: 'ACX101' };
    expect((await call(h, 'assign_standby_crew', input)).ok).toBe(false);
    okData(await call(h, 'assign_standby_crew', input, { approvedBy: DUTY_MANAGER }));
    expect(h.state.crew.crew['crew-cpt-sby'].status).toBe('assigned');
  });

  it('extend_crew_fdp always refuses', async () => {
    const h = await fixtureHarness();
    expect(
      await call(h, 'extend_crew_fdp', { crewId: 'crew-cpt-1', minutes: 60 }, { approvedBy: DUTY_MANAGER }),
    ).toMatchObject({
      ok: false,
      error: expect.stringMatching(/cannot be exceeded/),
    });
  });
});
