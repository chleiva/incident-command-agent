/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Store conformance suite. Every Store implementation must pass it:
 *   runStoreConformance('MemoryStore', () => new MemoryStore());
 * It runs against MemoryStore in unit tests and against DynamoStore when DYNAMO_ENDPOINT is set.
 */
import { describe, expect, it } from 'vitest';
import {
  RunNotFoundError,
  ZERO_TOTALS,
  mutationDraft,
  type ApprovalRecord,
  type EvalReport,
  type EventDraft,
  type RunMeta,
  type Scenario,
  type Store,
} from '@ica/schema';
import minimal from '@ica/schema/fixtures/scenario.minimal.json' with { type: 'json' };

let counter = 0;
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${(counter++).toString(36)}`;

export function makeRunMeta(overrides: Partial<RunMeta> = {}): RunMeta {
  return {
    runId: uid('run'),
    scenarioId: 'fx-minimal-cargo-door-sensor',
    scenarioTitle: 'Fixture',
    mode: 'agent',
    status: 'created',
    createdAt: new Date().toISOString(),
    simMinute: 0,
    lastSeq: 0,
    totals: { ...ZERO_TOTALS },
    speed: 6,
    ...overrides,
  };
}

export function tickDraft(simMinute: number): EventDraft<'world.tick'> {
  return {
    type: 'world.tick',
    actor: { kind: 'world' },
    simMinute,
    simTime: new Date(Date.UTC(2026, 5, 12, 5, 30) + simMinute * 60_000).toISOString(),
    payload: { simMinute },
  };
}

export function runStoreConformance(name: string, factory: () => Store | Promise<Store>): void {
  describe(`Store conformance: ${name}`, () => {
    it('stores and lists scenarios', async () => {
      const store = await factory();
      const s = { ...(minimal as unknown as Scenario), id: uid('scn'), visibility: 'private' as const };
      await store.putScenario(s);
      expect(await store.getScenario(s.id)).toEqual(s);
      expect(await store.getScenario('missing-id')).toBeNull();
      const list = await store.listScenarios();
      const mine = list.find((x) => x.id === s.id);
      expect(mine).toMatchObject({ id: s.id, station: 'MAN', aircraftType: 'A320', visibility: 'private' });
    });

    it('creates, reads, updates and lists runs', async () => {
      const store = await factory();
      const t0 = new Date(Date.now() - 1000).toISOString();
      const a = makeRunMeta({ createdAt: new Date(Date.now() - 500).toISOString() });
      const b = makeRunMeta({ createdAt: new Date().toISOString() });
      await store.createRun(a);
      await store.createRun(b);
      expect(await store.getRun(a.runId)).toMatchObject({ runId: a.runId, lastSeq: 0, status: 'created' });
      expect(await store.getRun('nope')).toBeNull();

      await store.updateRun(a.runId, { status: 'running', lastSeq: 999, speed: 12 });
      const a2 = await store.getRun(a.runId);
      expect(a2?.status).toBe('running');
      expect(a2?.speed).toBe(12);
      expect(a2?.lastSeq).toBe(0); // lastSeq is owned by append
      await expect(store.updateRun('nope', { status: 'running' })).rejects.toBeInstanceOf(RunNotFoundError);

      const runs = await store.listRuns(50);
      const ia = runs.findIndex((r) => r.runId === a.runId);
      const ib = runs.findIndex((r) => r.runId === b.runId);
      expect(ib).toBeGreaterThanOrEqual(0);
      expect(ib).toBeLessThan(ia); // newest first
      expect(await store.countRunsSince(t0)).toBeGreaterThanOrEqual(2);
      expect(await store.countRunsSince('2999-01-01T00:00:00.000Z')).toBe(0);
    });

    it('assigns gap-free seqs on append and pages events', async () => {
      const store = await factory();
      const meta = makeRunMeta();
      await store.createRun(meta);
      const first = await store.append(meta.runId, [tickDraft(1), tickDraft(2)]);
      expect(first.map((e) => e.seq)).toEqual([1, 2]);
      expect(first[0].runId).toBe(meta.runId);
      expect(first[0].wallTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      const second = await store.append(meta.runId, [tickDraft(3)]);
      expect(second[0].seq).toBe(3);
      expect(await store.append(meta.runId, [])).toEqual([]);

      const run = await store.getRun(meta.runId);
      expect(run?.lastSeq).toBe(3);
      expect(run?.simMinute).toBe(3);

      const p1 = await store.listEvents(meta.runId, 0, 2);
      expect(p1.events.map((e) => e.seq)).toEqual([1, 2]);
      expect(p1.hasMore).toBe(true);
      expect(p1.lastSeq).toBe(3);
      const p2 = await store.listEvents(meta.runId, 2, 2);
      expect(p2.events.map((e) => e.seq)).toEqual([3]);
      expect(p2.hasMore).toBe(false);
      const p3 = await store.listEvents(meta.runId, 3);
      expect(p3.events).toEqual([]);
    });

    it('rejects append to an unknown run', async () => {
      const store = await factory();
      await expect(store.append('no-such-run', [tickDraft(1)])).rejects.toBeInstanceOf(RunNotFoundError);
    });

    it('applies mutations atomically with their events and exposes system state', async () => {
      const store = await factory();
      const meta = makeRunMeta();
      await store.createRun(meta);
      const env = tickDraft(1);
      const envelope = { actor: env.actor, simMinute: 1, simTime: env.simTime };
      const eng = {
        id: 'eng-1',
        name: 'Ada Pennick',
        station: 'MAN',
        licence: 'B1',
        skills: [],
        status: 'available',
        location: 'MAN',
      };
      const m1 = {
        system: 'engineers' as const,
        entity: 'engineers',
        id: 'eng-1',
        op: 'create' as const,
        after: eng,
      };
      const m2 = {
        system: 'record' as const,
        entity: 'timeline',
        id: 'tl#1',
        op: 'create' as const,
        after: { id: 'tl#1', atMinute: 1, text: 'hello', source: 'world' },
      };
      const evs = await store.append(
        meta.runId,
        [mutationDraft(m1, envelope), mutationDraft(m2, envelope)],
        [m1, m2],
      );
      expect(evs.map((e) => e.type)).toEqual(['system.mutation', 'system.mutation']);

      const all = await store.getSystemState(meta.runId);
      expect(all.engineers?.engineers['eng-1']).toEqual(eng);
      expect(all.record?.timeline['tl#1']).toMatchObject({ text: 'hello' });
      expect(all.mne?.workOrders).toEqual({});

      const upd = { ...m1, op: 'update' as const, after: { ...eng, status: 'paged' } };
      await store.append(meta.runId, [mutationDraft(upd, envelope)], [upd]);
      const only = await store.getSystemState(meta.runId, 'engineers');
      expect(Object.keys(only)).toEqual(['engineers']);
      expect(only.engineers?.engineers['eng-1'].status).toBe('paged');

      const del = { ...m2, op: 'delete' as const, after: undefined };
      await store.append(meta.runId, [mutationDraft(del, envelope)], [del]);
      expect((await store.getSystemState(meta.runId, 'record')).record?.timeline).toEqual({});
      expect((await store.getRun(meta.runId))?.lastSeq).toBe(4);
    });

    it('keeps seqs gap-free under concurrent appends from two writers', async () => {
      const store = await factory();
      const meta = makeRunMeta();
      await store.createRun(meta);
      const N = 12;
      const writer = async (offset: number) => {
        const out: number[] = [];
        for (let i = 0; i < N; i++) {
          const batch = await store.append(meta.runId, [tickDraft(offset + i), tickDraft(offset + i + 0.5)]);
          out.push(...batch.map((e) => e.seq));
        }
        return out;
      };
      const [a, b] = await Promise.all([writer(0), writer(100)]);
      const all = [...a, ...b].sort((x, y) => x - y);
      expect(all).toEqual(Array.from({ length: 4 * N }, (_, i) => i + 1));
      // each writer's batches kept contiguous and in order
      for (const seqs of [a, b]) {
        for (let i = 0; i < seqs.length; i += 2) expect(seqs[i + 1]).toBe(seqs[i] + 1);
        expect([...seqs].sort((x, y) => x - y)).toEqual(seqs);
      }
      const page = await store.listEvents(meta.runId, 0, 500);
      expect(page.events.map((e) => e.seq)).toEqual(all);
      expect(page.lastSeq).toBe(4 * N);
    });

    it('stores approvals and filters by status', async () => {
      const store = await factory();
      const meta = makeRunMeta();
      await store.createRun(meta);
      const base: ApprovalRecord = {
        runId: meta.runId,
        approvalId: 'apr-1',
        status: 'pending',
        agentRunId: 'ar-1',
        role: 'passenger',
        toolCallId: 'tc-1',
        tool: 'send_passenger_message',
        args: { messageId: 'msg-1' },
        summary: 'Send',
        proposalSeq: 5,
        createdAtMinute: 4,
      };
      await store.putApproval(base);
      await store.putApproval({ ...base, approvalId: 'apr-2', proposalSeq: 9 });
      expect(await store.getApproval(meta.runId, 'apr-1')).toEqual(base);
      expect(await store.getApproval(meta.runId, 'nope')).toBeNull();
      await store.putApproval({
        ...base,
        status: 'approved',
        decision: {
          decision: 'approve',
          decidedBy: { kind: 'human', name: 'Sam Okafor', roleTitle: 'Duty Manager' },
          seq: 7,
          decidedAt: new Date().toISOString(),
        },
      });
      expect((await store.listApprovals(meta.runId)).map((a) => a.approvalId)).toEqual(['apr-1', 'apr-2']);
      expect((await store.listApprovals(meta.runId, 'pending')).map((a) => a.approvalId)).toEqual(['apr-2']);
      expect((await store.listApprovals(meta.runId, 'approved'))[0].decision?.seq).toBe(7);
    });

    it('decideApproval accepts exactly one of two simultaneous decisions', async () => {
      const store = await factory();
      const meta = makeRunMeta();
      await store.createRun(meta);
      const base: ApprovalRecord = {
        runId: meta.runId,
        approvalId: 'apr-race',
        status: 'pending',
        agentRunId: 'ar-1',
        role: 'flightops',
        toolCallId: 'tc-1',
        tool: 'propose_swap',
        args: {},
        summary: 'Swap',
        proposalSeq: 3,
        createdAtMinute: 2,
      };
      await store.putApproval(base);
      const results = await Promise.all([
        store.decideApproval(meta.runId, 'apr-race', 'pending', { status: 'approved' }),
        store.decideApproval(meta.runId, 'apr-race', 'pending', { status: 'rejected' }),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      const won = await store.getApproval(meta.runId, 'apr-race');
      expect(won?.status).toBe(results[0] ? 'approved' : 'rejected');
      expect((await store.listApprovals(meta.runId, 'pending')).length).toBe(0);
      expect((await store.listApprovals(meta.runId, won!.status)).map((a) => a.approvalId)).toEqual([
        'apr-race',
      ]);

      const decision = {
        decision: 'approve' as const,
        decidedBy: { kind: 'human' as const, name: 'Sam Okafor', roleTitle: 'Duty Manager' },
        seq: 9,
        decidedAt: new Date().toISOString(),
      };
      expect(await store.decideApproval(meta.runId, 'apr-race', won!.status, { decision })).toBe(true);
      expect((await store.getApproval(meta.runId, 'apr-race'))?.decision).toEqual(decision);
      // Revert (e.g. the decision event could not be written): status back, decision removed.
      expect(
        await store.decideApproval(meta.runId, 'apr-race', won!.status, {
          status: 'pending',
          decision: undefined,
        }),
      ).toBe(true);
      const reverted = await store.getApproval(meta.runId, 'apr-race');
      expect(reverted?.status).toBe('pending');
      expect(reverted?.decision).toBeUndefined();
      expect(await store.decideApproval(meta.runId, 'missing', 'pending', { status: 'approved' })).toBe(
        false,
      );
    });

    it('tracks websocket connections per run', async () => {
      const store = await factory();
      const runId = uid('run');
      const c1 = uid('c');
      const c2 = uid('c');
      await store.putConnection(c1, runId);
      await store.putConnection(c2, runId);
      await store.putConnection(uid('c'), uid('other'));
      expect((await store.listConnections(runId)).sort()).toEqual([c1, c2].sort());
      await store.deleteConnection(c1);
      expect(await store.listConnections(runId)).toEqual([c2]);
      await store.deleteConnection('never-existed');
    });

    it('returns the latest eval report', async () => {
      const store = await factory();
      const report = (id: string, createdAt: string): EvalReport => ({
        id,
        createdAt,
        tier: 'replay',
        caseCount: 1,
        passRateByLayer: { trajectory: 1 },
        hardAssertionPassRate: 1,
        judgeMean: null,
        spend: { usd: 0, gbp: 0 },
        ledger: { lifetimeCapGbp: 10, spentGbp: 0, reservedGbp: 0, remainingGbp: 10 },
        cases: [],
      });
      await store.putEvalReport(report(uid('ev'), '2999-01-01T00:00:00.000Z'));
      const newest = report(uid('ev'), '2999-01-02T00:00:00.000Z');
      await store.putEvalReport(newest);
      expect((await store.getLatestEvalReport())?.id).toBe(newest.id);
    });

    it('stores, replaces and reads author drafts', async () => {
      const store = await factory();
      const draftId = uid('draft');
      const screening = { verdict: 'clean' as const, findings: [] };
      await store.putAuthorDraft({
        draftId,
        status: 'pending',
        createdAt: new Date().toISOString(),
        screening,
      });
      expect(await store.getAuthorDraft(draftId)).toMatchObject({ draftId, status: 'pending' });
      await store.putAuthorDraft({
        draftId,
        status: 'failed',
        createdAt: new Date().toISOString(),
        screening,
        errors: ['boom'],
      });
      expect(await store.getAuthorDraft(draftId)).toMatchObject({ status: 'failed', errors: ['boom'] });
      expect(await store.getAuthorDraft('missing-draft')).toBeNull();
    });

    it('keeps the additive RunMeta.preparing flag through create and update', async () => {
      const store = await factory();
      const m = makeRunMeta({ preparing: true });
      await store.createRun(m);
      expect((await store.getRun(m.runId))?.preparing).toBe(true);
      await store.updateRun(m.runId, { preparing: false });
      expect((await store.getRun(m.runId))?.preparing).toBe(false);
    });
  });
}
