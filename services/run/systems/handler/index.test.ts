/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import { seededRng } from '../names';
import { harness } from '../testing';
import { applyMutations } from '../util';
import { TASK_DURATION_MIN, ackAt, createHandlerTask } from './index';

describe('handler', () => {
  it('seeds equipment pools keyed {station}:{kind}', () => {
    const { state } = harness();
    expect(state.handler.equipment['MAN:tug']).toMatchObject({ available: 2, total: 2, kind: 'tug' });
  });

  it('acknowledges after ackMinutes ± jitter (−1…+2), never under a minute', () => {
    const rng = seededRng(7);
    for (let i = 0; i < 50; i++) {
      const a = ackAt(10, 4, rng);
      expect(a).toBeGreaterThanOrEqual(13);
      expect(a).toBeLessThanOrEqual(16);
    }
    expect(ackAt(10, 0, rng)).toBeGreaterThanOrEqual(11);
  });

  it('task lifecycle queued → acknowledged → in_progress → done, holding and restoring equipment', () => {
    const h = harness();
    const r = createHandlerTask(
      h.state,
      { station: 'MAN', kind: 'stairs', tail: 'AX-FXA', equipmentKind: 'stairs' },
      0,
      4,
      h.rng,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.note).toBe('Position passenger stairs for AX-FXA (1 × stairs reserved)');
    h.state = applyMutations(h.state, r.mutations);
    expect(h.state.handler.equipment['MAN:stairs'].available).toBe(2);
    const t = r.value;
    h.advanceTo(t.ackAtMinute);
    expect(h.state.handler.tasks[t.id].status).toBe('acknowledged');
    h.advanceTo(t.ackAtMinute + 1);
    expect(h.state.handler.tasks[t.id].status).toBe('in_progress');
    h.advanceTo(t.ackAtMinute + TASK_DURATION_MIN.stairs);
    expect(h.state.handler.tasks[t.id].status).toBe('done');
    expect(h.state.handler.equipment['MAN:stairs'].available).toBe(3);
  });

  it('refuses a task needing equipment the handler lacks', () => {
    const h = harness();
    expect(
      createHandlerTask(h.state, { station: 'MAN', kind: 'gpu', equipmentKind: 'gpu' }, 0, 4, h.rng).ok,
    ).toBe(false);
  });
});
