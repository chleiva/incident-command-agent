/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import { foldEvents, validateEvent, validateScenario, type RunEvent } from '@ica/schema';
import { describe, expect, it } from 'vitest';
import { RECORDINGS } from './recordings';

describe('mock-mode recordings are valid contract data', () => {
  for (const rec of RECORDINGS) {
    describe(rec.scenario.id, () => {
      it('scenario validates against scenario.schema.json', () => {
        const r = validateScenario(rec.scenario);
        expect(r.ok ? [] : r.errors).toEqual([]);
      });

      for (const [kind, events] of [
        ['agent', rec.agent],
        ['baseline', rec.baseline],
      ] as [string, RunEvent[]][]) {
        it(`${kind} run: every event validates, seqs are gap-free and time is monotonic`, () => {
          const errors = events.flatMap((e) => {
            const r = validateEvent(e);
            return r.ok ? [] : [`#${e.seq} ${e.type}: ${r.errors.join('; ')}`];
          });
          expect(errors).toEqual([]);
          events.forEach((e, i) => expect(e.seq).toBe(i + 1));
          for (let i = 1; i < events.length; i++) {
            expect(events[i]!.simMinute).toBeGreaterThanOrEqual(events[i - 1]!.simMinute);
          }
          const runIds = new Set(events.map((e) => e.runId));
          expect(runIds.size).toBe(1);
        });

        it(`${kind} run: folds with the shared reducer to a completed run`, () => {
          const p = foldEvents(events);
          expect(p.meta.status).toBe('completed');
          expect(p.meta.mode).toBe(kind);
          expect(p.pendingApprovalIds).toEqual([]);
          expect(p.kpis).not.toBeNull();
        });
      }

      it('agent run covers every zone', () => {
        const types = new Set(rec.agent.map((e) => e.type));
        for (const t of [
          'agent.proposal',
          'approval.decision',
          'world.twist',
          'guardrail.blocked',
          'agent.report',
          'kpi.update',
          'world.process',
        ]) {
          expect(types, t).toContain(t);
        }
        const p = foldEvents(rec.agent);
        expect(Object.values(p.approvals).some((a) => (a.options?.length ?? 0) >= 3)).toBe(true);
        expect(
          Object.values(p.systems.pss.messages).filter((m) => m.status === 'sent').length,
        ).toBeGreaterThan(0);
        expect(
          Object.keys(p.systems.record.evidencePacks).length + Object.keys(p.systems.record.reports).length,
        ).toBeGreaterThan(0);
        expect(p.meta.pairedRunId).toBe(rec.baseline[0]!.runId);
      });
    });
  }

  it('the s01 recording is the rich one (~300 events)', () => {
    expect(RECORDINGS[0]!.agent.length).toBeGreaterThanOrEqual(280);
  });
});
