/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Fake runner for local development and tests until task 02's `executeRun` lands. It replays the scripted run in
 * `@ica/schema/fixtures/run.sample.events.json` against a real run: persisting mock-state mutations, writing
 * pending `ApprovalRecord`s and BLOCKING on each proposal until the API records a human decision, and honouring
 * `control.requested` (pause/resume/stop/set_speed) and `twist.requested`. No LLM calls.
 */
import {
  type AgentRole,
  type ApprovalRecord,
  type EventDraft,
  type RunEvent,
  type Store,
  type SystemMutation,
} from '@ica/schema';
import sample from '@ica/schema/fixtures/run.sample.events.json' with { type: 'json' };

export interface FakeRunOptions {
  store: Store;
  runId: string;
  /** Real milliseconds per template step at speed 6 (default 400); scaled by the run speed. */
  stepMs?: number;
  signal?: AbortSignal;
  /** Poll interval while blocked on an approval or paused (default 150 ms). */
  pollMs?: number;
  template?: RunEvent[];
}

const TEMPLATE = sample as unknown as RunEvent[];

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    });
  });

function shiftIso(iso: string, offsetMs: number): string {
  return new Date(new Date(iso).getTime() + offsetMs).toISOString();
}

function toDraft(e: RunEvent, offsetMs: number): EventDraft {
  const { runId: _r, seq: _s, wallTime: _w, ...rest } = e;
  return { ...rest, simTime: shiftIso(e.simTime, offsetMs) } as EventDraft;
}

/** Run the scripted fixture against `runId`. Resolves when the run completes or is stopped. */
export async function fakeRun(opts: FakeRunOptions): Promise<void> {
  const { store, runId, signal } = opts;
  const pollMs = opts.pollMs ?? 150;
  const template = (opts.template ?? TEMPLATE).filter(
    (e) => e.type !== 'run.created' && e.type !== 'approval.decision',
  );
  const meta = await store.getRun(runId);
  if (!meta) throw new Error(`run not found: ${runId}`);
  const first = (await store.listEvents(runId, 0, 1)).events[0];
  const fixtureStart = (opts.template ?? TEMPLATE)[0]?.simTime;
  const offsetMs =
    first && fixtureStart ? new Date(first.simTime).getTime() - new Date(fixtureStart).getTime() : 0;

  let speed = meta.speed || 6;
  let seenSeq = meta.lastSeq;
  let paused = false;
  let stopped = false;
  let lastSim = { simMinute: 0, simTime: first?.simTime ?? new Date().toISOString() };
  const world = { kind: 'world' } as const;

  const append = async (drafts: EventDraft[], mutations?: SystemMutation[]) => {
    const out = await store.append(runId, drafts, mutations);
    const last = out.at(-1);
    if (last) lastSim = { simMinute: last.simMinute, simTime: last.simTime };
    return out;
  };

  /** Apply control/twist requests written by the API since we last looked. */
  const drain = async () => {
    const page = await store.listEvents(runId, seenSeq, 500);
    for (const e of page.events) {
      seenSeq = Math.max(seenSeq, e.seq);
      if (e.type === 'control.requested') {
        const p = e.payload;
        if (p.action === 'pause' && !paused) {
          paused = true;
          await store.updateRun(runId, { status: 'paused' });
          await append([{ type: 'run.paused', payload: { speed }, actor: world, ...lastSim }]);
        } else if (p.action === 'resume' && paused) {
          paused = false;
          await store.updateRun(runId, { status: 'running' });
          await append([{ type: 'run.resumed', payload: { speed }, actor: world, ...lastSim }]);
        } else if (p.action === 'set_speed' && p.speed) {
          speed = p.speed;
          await store.updateRun(runId, { speed });
          await append([{ type: 'run.speed_changed', payload: { speed }, actor: world, ...lastSim }]);
        } else if (p.action === 'stop') {
          stopped = true;
        }
      } else if (e.type === 'twist.requested') {
        const p = e.payload;
        await append([
          {
            type: 'world.twist',
            payload: {
              ...(p.twistId ? { twistId: p.twistId } : {}),
              title: p.twistId ? `Twist ${p.twistId}` : 'Free-text twist',
              description: p.text ?? 'Scenario twist injected by the operator.',
              source: p.twistId ? 'manual' : 'free_text',
              effects: [],
            },
            actor: world,
            ...lastSim,
          },
        ]);
      }
    }
  };

  const wait = async (ms: number) => {
    await sleep(ms, signal);
    await drain();
    while (paused && !stopped && !signal?.aborted) {
      await sleep(pollMs, signal);
      await drain();
    }
  };

  for (const tpl of template) {
    if (stopped || signal?.aborted) break;
    const d = toDraft(tpl, offsetMs);
    if (tpl.type === 'system.mutation') {
      const p = tpl.payload;
      const m: SystemMutation = { system: p.system, entity: p.entity, id: p.id, op: p.op };
      if (p.after) m.after = p.after as Record<string, unknown>;
      if (p.before) m.before = p.before as Record<string, unknown>;
      await append([d], [m]);
    } else if (tpl.type === 'agent.proposal') {
      const [e] = await append([d]);
      const p = tpl.payload;
      const rec: ApprovalRecord = {
        runId,
        approvalId: p.approvalId,
        status: 'pending',
        agentRunId: tpl.agentRunId ?? 'unknown',
        role: (tpl.actor.kind === 'agent' ? tpl.actor.role : 'orchestrator') as AgentRole,
        toolCallId: p.toolCallId,
        tool: p.tool,
        args: p.args,
        summary: p.summary,
        reasoning: p.reasoning,
        ...(p.options ? { options: p.options } : {}),
        proposalSeq: e.seq,
        createdAtMinute: e.simMinute,
        ...(p.expiresAtMinute !== undefined ? { expiresAtMinute: p.expiresAtMinute } : {}),
      };
      await store.putApproval(rec);
      // Block (like the real runtime) until a human decides.
      while (!stopped && !signal?.aborted) {
        const cur = await store.getApproval(runId, p.approvalId);
        if (cur && cur.status !== 'pending') break;
        await wait(pollMs);
      }
      continue;
    } else if (tpl.type === 'run.completed') {
      await store.updateRun(runId, {
        status: 'completed',
        totals: tpl.payload.totals,
        endedAt: new Date().toISOString(),
      });
      await append([d]);
      return;
    } else {
      await append([d]);
    }
    if (tpl.type === 'run.started') await store.updateRun(runId, { status: 'running' });
    await wait(Math.max(10, ((opts.stepMs ?? 400) * 6) / speed));
  }

  if (stopped || signal?.aborted) {
    const fin = template.find((e) => e.type === 'run.completed') as RunEvent<'run.completed'> | undefined;
    if (fin) {
      await append([
        {
          type: 'run.completed',
          payload: { ...fin.payload, reason: 'stopped' },
          actor: world,
          ...lastSim,
        },
      ]);
    }
    await store.updateRun(runId, { status: 'completed', endedAt: new Date().toISOString() });
    return;
  }
  await store.updateRun(runId, { status: 'completed', endedAt: new Date().toISOString() });
}
