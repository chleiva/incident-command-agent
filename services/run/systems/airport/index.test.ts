/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import { harness } from '../testing';
import { applyMutations } from '../util';
import { requestResource, requestStand } from './index';

describe('airport stands', () => {
  it('confirms a free stand 3–8 minutes after the request and moves the aircraft', () => {
    const h = harness();
    const r = requestStand(h.state, { standId: 'R5', tail: 'NW-FXA' }, 0, h.rng);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.confirmAtMinute).toBeGreaterThanOrEqual(3);
    expect(r.value.confirmAtMinute).toBeLessThanOrEqual(8);
    h.state = applyMutations(h.state, r.mutations);
    h.advanceTo(r.value.confirmAtMinute - 1);
    expect(h.state.airport.standRequests[r.value.id].status).toBe('requested');
    h.advanceTo(r.value.confirmAtMinute);
    expect(h.state.airport.standRequests[r.value.id].status).toBe('confirmed');
    expect(h.state.airport.stands.R5.occupiedByTail).toBe('NW-FXA');
    expect(h.state.airport.stands['22'].occupiedByTail).toBeUndefined();
    expect(h.state.mne.aircraft['NW-FXA'].stand).toBe('R5');
  });

  it('rejects the request if the stand is still occupied at confirmation', () => {
    const h = harness();
    const r = requestStand(h.state, { standId: '24', tail: 'NW-FXA' }, 0, h.rng); // NW-FXB until minute 45
    if (!r.ok) throw new Error(r.error);
    h.state = applyMutations(h.state, r.mutations);
    h.advanceTo(10);
    expect(h.state.airport.standRequests[r.value.id].status).toBe('rejected');
  });

  it('frees a stand when its occupant leaves', () => {
    const h = harness();
    h.advanceTo(45);
    expect(h.state.airport.stands['24'].occupiedByTail).toBeUndefined();
  });

  it('refuses unknown stands and duplicate pending requests', () => {
    const h = harness();
    expect(requestStand(h.state, { standId: 'X9', tail: 'NW-FXA' }, 0, h.rng).ok).toBe(false);
    const r = requestStand(h.state, { standId: 'R5', tail: 'NW-FXA' }, 0, h.rng);
    h.state = applyMutations(h.state, r.ok ? r.mutations : []);
    expect(requestStand(h.state, { standId: '24', tail: 'NW-FXA' }, 0, h.rng).ok).toBe(false);
  });
});

describe('airport resources', () => {
  it('a tow takes a tug from the pool, arrives at its ETA and restores the pool when released', () => {
    const h = harness();
    const r = requestResource(h.state, { kind: 'tow', station: 'MAN', tail: 'NW-FXA' }, 0, 4, h.rng);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    h.state = applyMutations(h.state, r.mutations);
    expect(h.state.handler.equipment['MAN:tug'].available).toBe(1);
    h.advanceTo(r.value.etaMinute);
    expect(h.state.airport.resourceRequests[r.value.id].status).toBe('on_site');
    h.advanceTo(r.value.releaseAtMinute!);
    expect(h.state.airport.resourceRequests[r.value.id].status).toBe('released');
    expect(h.state.handler.equipment['MAN:tug'].available).toBe(2);
  });

  it('refuses when the pool is empty or the handler has no such equipment', () => {
    const h = harness();
    for (let i = 0; i < 2; i++) {
      const r = requestResource(h.state, { kind: 'tow', station: 'MAN' }, 0, 4, h.rng);
      h.state = applyMutations(h.state, r.ok ? r.mutations : []);
    }
    expect(requestResource(h.state, { kind: 'tow', station: 'MAN' }, 0, 4, h.rng)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/no tug available/),
    });
    expect(requestResource(h.state, { kind: 'gpu', station: 'MAN' }, 0, 4, h.rng).ok).toBe(false);
    expect(requestResource(h.state, { kind: 'fire_service', station: 'MAN' }, 0, 4, h.rng).ok).toBe(true);
  });
});
