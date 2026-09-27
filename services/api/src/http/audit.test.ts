/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  ZERO_TOTALS,
  draft,
  type Actor,
  type AuditLlmEntry,
  type AuditToolEntry,
  type EventDraft,
  type RunAuditLlmResponse,
  type RunAuditResponse,
} from '@ica/schema';
import { MemoryStore } from '@ica/store';
import { describe, expect, it } from 'vitest';
import { SCENARIO, json, makeDeps, req } from '../test-helpers';
import { rehydrateEvents } from './audit';

const RUN = 'run-audit-1';
const ORCH: Actor = { kind: 'agent', role: 'orchestrator' };
const PAX: Actor = { kind: 'agent', role: 'passenger' };
const HUMAN: Actor = { kind: 'human', name: 'Duty Manager One', roleTitle: 'Duty Manager' };
const env = (simMinute: number, extra: Record<string, unknown> = {}) => ({
  actor: ORCH,
  simMinute,
  simTime: new Date(Date.parse(SCENARIO.startSimTime) + simMinute * 60_000).toISOString(),
  ...extra,
});

const TRACE_0 = {
  kind: 'llm',
  runId: RUN,
  agentRunId: 'ar-orchestrator-1',
  agentPath: 'orchestrator',
  role: 'orchestrator',
  iteration: 0,
  provider: 'scripted',
  model: 'test-model',
  latencyMs: 812,
  request: { model: 'test-model', system: 'SYSTEM', messages: [{ role: 'user', content: [] }], tools: [] },
  response: {
    text: 'Opening.',
    toolCalls: [],
    usage: { inputTokens: 10, outputTokens: 2 },
    stopReason: 'tool_use',
  },
};

async function seed(h: ReturnType<typeof makeDeps>, store = h.store) {
  await store.createRun({
    runId: RUN,
    scenarioId: SCENARIO.id,
    scenarioTitle: SCENARIO.title,
    mode: 'agent',
    status: 'completed',
    createdAt: '2026-06-01T09:00:00.000Z',
    simMinute: 0,
    lastSeq: 0,
    totals: { ...ZERO_TOTALS },
    speed: 10,
  });
  const k0 = await h.traces.put(RUN, 'ar-orchestrator-1-i000', TRACE_0);
  // A failed call: a trace but no agent.thought.
  await h.traces.put(RUN, 'ar-passenger-1-i001', { ...TRACE_0, agentRunId: 'ar-passenger-1', error: 'boom' });
  // Not LLM calls: an export and an offloaded payload.
  await h.traces.put(RUN, 'export', []);
  const drafts: EventDraft[] = [
    draft(
      'agent.started',
      { role: 'orchestrator', brief: 'Coordinate' },
      env(0, { agentRunId: 'ar-orchestrator-1' }),
    ),
    draft(
      'agent.started',
      { role: 'passenger', brief: 'Inform' },
      env(0.5, { actor: PAX, agentRunId: 'ar-passenger-1' }),
    ),
    draft(
      'agent.thought',
      { text: 'Opening the incident.', summary: 'Opening the incident.' },
      env(1, {
        agentRunId: 'ar-orchestrator-1',
        iteration: 0,
        traceKey: k0,
        latencyMs: 812,
        usage: {
          inputTokens: 10,
          outputTokens: 2,
          cacheReadTokens: 7,
          cacheWriteTokens: 3,
          costUsd: 0.0012,
          model: 'test-model',
          provider: 'scripted',
        },
      }),
    ),
    draft(
      'agent.tool_call',
      {
        toolCallId: 'tc-1',
        tool: 'open_incident',
        system: 'runtime',
        tier: 'execute',
        args: { title: 'Nose-gear contact' },
        argsRepaired: ['/title'],
      },
      env(1.1, { agentRunId: 'ar-orchestrator-1', iteration: 0 }),
    ),
    draft(
      'agent.tool_result',
      {
        toolCallId: 'tc-1',
        tool: 'open_incident',
        ok: true,
        resultPreview: '{"id":"inc-1"}',
        result: { id: 'inc-1', big: 'x'.repeat(2000) },
      },
      env(1.1, { agentRunId: 'ar-orchestrator-1', iteration: 0, latencyMs: 40 }),
    ),
    draft(
      'agent.tool_call',
      {
        toolCallId: 'tc-2',
        tool: 'send_passenger_message',
        system: 'pss',
        tier: 'propose',
        args: { body: 'Hello' },
      },
      env(2, { actor: PAX, agentRunId: 'ar-passenger-1', iteration: 1 }),
    ),
    draft(
      'agent.proposal',
      {
        approvalId: 'ap-1',
        toolCallId: 'tc-2',
        tool: 'send_passenger_message',
        args: { body: 'Hello' },
        summary: 'Send update',
        reasoning: 'r',
      },
      env(2, { actor: PAX, agentRunId: 'ar-passenger-1', iteration: 1 }),
    ),
    draft(
      'approval.decision',
      { approvalId: 'ap-1', decision: 'approve', decidedBy: HUMAN },
      env(3, { actor: HUMAN }),
    ),
    draft(
      'agent.tool_result',
      {
        toolCallId: 'tc-2',
        tool: 'send_passenger_message',
        ok: true,
        resultPreview: 'sent',
        result: { status: 'sent' },
      },
      env(3, { actor: PAX, agentRunId: 'ar-passenger-1', iteration: 1 }),
    ),
    draft(
      'guardrail.blocked',
      {
        layer: 'arg_validation',
        tool: 'made_up_tool',
        reason: "unknown tool 'made_up_tool'",
        toolCallId: 'tc-3',
      },
      env(4, { agentRunId: 'ar-orchestrator-1', iteration: 1 }),
    ),
  ];
  await store.append(RUN, drafts);
  return { k0 };
}

const audit = async (h: ReturnType<typeof makeDeps>, query: Record<string, string> = {}) => {
  const r = await h.handler(req('GET', `/runs/${RUN}/audit`, { query }));
  expect(r.statusCode, r.body).toBe(200);
  return json<RunAuditResponse>(r);
};

describe('GET /runs/{id}/audit', () => {
  it('lists LLM and tool calls chronologically with joins, run name and usage', async () => {
    const h = makeDeps();
    const { k0 } = await seed(h);
    const a = await audit(h);
    expect(a.runName).toContain(SCENARIO.title);
    expect(a.tracesListed).toBe(true);
    expect(a.entries.map((e) => e.id)).toEqual([
      `llm:${k0}`,
      'tool:tc-1',
      'tool:tc-2',
      'tool:tc-3',
      `llm:traces/${RUN}/ar-passenger-1-i001.json`,
    ]);
    const llm = a.entries[0] as AuditLlmEntry;
    expect(llm).toMatchObject({
      kind: 'llm',
      traceKey: k0,
      agentRunId: 'ar-orchestrator-1',
      role: 'orchestrator',
      iteration: 0,
      model: 'test-model',
      provider: 'scripted',
      usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 7, cacheWriteTokens: 3 },
      costUsd: 0.0012,
      latencyMs: 812,
      simMinute: 1,
    });
    expect(llm.sizeBytes).toBeGreaterThan(0);
    expect(llm).not.toHaveProperty('request');
    const tc1 = a.entries[1] as AuditToolEntry;
    expect(tc1).toMatchObject({
      tool: 'open_incident',
      tier: 'execute',
      ok: true,
      latencyMs: 40,
      argsRepaired: ['/title'],
    });
    expect((tc1.result as { big: string }).big).toHaveLength(2000);
    const tc2 = a.entries[2] as AuditToolEntry;
    expect(tc2.proposal).toMatchObject({ approvalId: 'ap-1', summary: 'Send update' });
    expect(tc2.decision).toMatchObject({ decision: 'approve', decidedBy: HUMAN });
    expect(tc2.role).toBe('passenger');
    const tc3 = a.entries[3] as AuditToolEntry;
    expect(tc3).toMatchObject({ tool: 'made_up_tool', ok: false, blocked: { layer: 'arg_validation' } });
    const failed = a.entries[4] as AuditLlmEntry;
    expect(failed).toMatchObject({ unmatched: true, role: 'passenger', iteration: 1 });
  });

  it('paginates with a cursor', async () => {
    const h = makeDeps();
    await seed(h);
    const p1 = await audit(h, { limit: '2' });
    expect(p1.entries).toHaveLength(2);
    expect(p1.total).toBe(5);
    expect(p1.nextCursor).toBe('2');
    const p2 = await audit(h, { limit: '2', cursor: p1.nextCursor! });
    const p3 = await audit(h, { limit: '2', cursor: p2.nextCursor! });
    expect(p3.nextCursor).toBeUndefined();
    expect([...p1.entries, ...p2.entries, ...p3.entries].map((e) => e.id)).toEqual(
      (await audit(h)).entries.map((e) => e.id),
    );
    const bad = await h.handler(req('GET', `/runs/${RUN}/audit`, { query: { cursor: '-1' } }));
    expect(bad.statusCode).toBe(400);
  });

  it('rehydrates offloaded payloads (the itemToEvent layout)', async () => {
    const store = new MemoryStore({ validateEvents: false });
    const h = makeDeps({ store });
    await seed(h, store);
    const full = {
      toolCallId: 'tc-9',
      tool: 'get_flight',
      ok: true,
      resultPreview: '…',
      result: { rows: 'y'.repeat(40_000) },
    };
    await store.append(RUN, [
      draft(
        'agent.tool_call',
        { toolCallId: 'tc-9', tool: 'get_flight', system: 'occ', tier: 'execute', args: {} },
        env(5),
      ),
      {
        ...draft('agent.tool_result', full, env(5)),
        payload: { _truncated: true, preview: '…' },
      } as unknown as EventDraft,
    ]);
    const seq = (await store.getRun(RUN))!.lastSeq;
    await h.traces.put(
      RUN,
      seq,
      { runId: RUN, seq, type: 'agent.tool_result', payload: full },
      { suffix: '.payload' },
    );
    const a = await audit(h);
    const tc9 = a.entries.find((e) => e.id === 'tool:tc-9') as AuditToolEntry;
    expect((tc9.result as { rows: string }).rows).toHaveLength(40_000);
    // The .payload.json object is not an LLM call.
    expect(a.entries.filter((e) => e.kind === 'llm')).toHaveLength(2);
  });

  it('still lists every LLM call with an event when the trace store cannot list', async () => {
    const h = makeDeps();
    await seed(h);
    h.traces.list = async () => {
      throw new Error('AccessDenied');
    };
    const a = await audit(h);
    expect(a.tracesListed).toBe(false);
    expect(a.entries.filter((e) => e.kind === 'llm')).toHaveLength(1);
  });

  it('404s for an unknown run and requires authentication', async () => {
    const h = makeDeps();
    expect((await h.handler(req('GET', '/runs/nope/audit'))).statusCode).toBe(404);
    await seed(h);
    const r = await h.handler(req('GET', `/runs/${RUN}/audit`, { claims: null }));
    expect(r.statusCode).toBe(401);
    const r2 = await h.handler(req('GET', `/runs/${RUN}/audit/llm`, { claims: null, query: { key: 'x' } }));
    expect(r2.statusCode).toBe(401);
  });
});

describe('GET /runs/{id}/audit/llm', () => {
  it('returns the stored trace exactly as written', async () => {
    const h = makeDeps();
    const { k0 } = await seed(h);
    const r = await h.handler(req('GET', `/runs/${RUN}/audit/llm`, { query: { key: k0 } }));
    expect(r.statusCode).toBe(200);
    const body = json<RunAuditLlmResponse>(r);
    expect(body.trace).toEqual(TRACE_0);
    expect(body.url).toBeUndefined();
    expect(body.sizeBytes).toBe(Buffer.byteLength(JSON.stringify(TRACE_0)));
  });

  it.each([
    ['another run', 'traces/run-other/ar-orchestrator-1-i000.json'],
    ['a traversal', `traces/${RUN}/../run-other/ar-orchestrator-1-i000.json`],
    ['a nested path', `traces/${RUN}/sub/x.json`],
    ['a prefix run id', `traces/${RUN}x/ar-orchestrator-1-i000.json`],
    ['a non-trace key', 'config/brand.json'],
    ['an empty key', ''],
  ])('rejects %s', async (_name, key) => {
    const h = makeDeps();
    await seed(h);
    await h.traces.put('run-other', 'ar-orchestrator-1-i000', { secret: true });
    const r = await h.handler(req('GET', `/runs/${RUN}/audit/llm`, { query: { key } }));
    expect(r.statusCode).toBe(400);
    expect(r.body).not.toContain('secret');
  });

  it('404s for a missing trace of the run', async () => {
    const h = makeDeps();
    await seed(h);
    const r = await h.handler(
      req('GET', `/runs/${RUN}/audit/llm`, { query: { key: `traces/${RUN}/gone-i000.json` } }),
    );
    expect(r.statusCode).toBe(404);
  });

  it('answers with a 5-minute presigned URL above the inline limit', async () => {
    const presigned: { key: string; expiresIn?: number }[] = [];
    const h = makeDeps({
      auditInlineMaxBytes: 100,
      presign: async (key, opts) => {
        presigned.push({ key, expiresIn: opts?.expiresIn });
        return `https://signed.example/${key}`;
      },
    });
    const { k0 } = await seed(h);
    const r = await h.handler(req('GET', `/runs/${RUN}/audit/llm`, { query: { key: k0 } }));
    const body = json<RunAuditLlmResponse>(r);
    expect(body.url).toBe(`https://signed.example/${k0}`);
    expect(body.trace).toBeUndefined();
    expect(presigned).toEqual([{ key: k0, expiresIn: 300 }]);
  });
});

describe('rehydrateEvents', () => {
  it('leaves events alone when the payload object is missing', async () => {
    const h = makeDeps();
    const e = { runId: RUN, seq: 3, type: 'agent.tool_result', payload: { _truncated: true, preview: 'p' } };
    expect(await rehydrateEvents([e as never], h.traces)).toEqual([e]);
  });
});
