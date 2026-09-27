/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * End-to-end over real sockets: local dev server (same router as the Lambda) + WebSocket + in-process launcher
 * falling back to the fake runner while `executeRun` is a stub. Proves list → start → live events → approve →
 * system state → completion, with no AWS and no LLM.
 */
import {
  applyEvent,
  emptyProjection,
  type RunEvent,
  type RunProjection,
  type WsServerMessage,
} from '@ica/schema';
import { MemoryEventBus, MemoryStore, MemoryTraceStore } from '@ica/store';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { DEFAULT_BRAND, FALLBACK_STATIONS } from '../config/app-config';
import { settingsFromEnv } from '../config/settings';
import { InProcessRunLauncher } from '../runner/launchers';
import { SCENARIO } from '../test-helpers';
import { createLocalApp, type LocalApp } from './app';

let app: LocalApp | null = null;
let launcher: InProcessRunLauncher | null = null;
afterEach(async () => {
  await launcher?.close();
  await app?.close();
  app = null;
  launcher = null;
});

async function start(mode: 'auto' | 'fake' = 'auto') {
  const bus = new MemoryEventBus();
  const store = new MemoryStore({ bus });
  launcher = new InProcessRunLauncher({
    store,
    mode,
    fakeStepMs: 5,
    executeRun: async () => {
      throw new Error('not implemented (task 02)');
    },
    deps: async () => ({
      store,
      traces: new MemoryTraceStore(),
      knowledge: { search: async () => [] },
      llm: {} as never,
    }),
  });
  app = createLocalApp({
    store,
    bus,
    traces: new MemoryTraceStore(),
    launcher,
    author: { start: async () => Promise.reject(new Error('not implemented (task 02)')) },
    screen: async () => ({ verdict: 'clean', findings: [] }),
    publicScenarios: [SCENARIO],
    settings: settingsFromEnv({ AUTH_MODE: 'none', LLM_PROVIDER: 'scripted', LLM_MODEL: 'fake' }),
    appConfigSource: async () => ({ brand: DEFAULT_BRAND, stations: FALLBACK_STATIONS }),
  });
  const port = await app.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const api = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`${base}${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, body: (await r.json().catch(() => null)) as any, headers: r.headers };
  };
  return { store, port, api, base };
}

function collect(port: number, runId: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?runId=${runId}`);
  const events: RunEvent[] = [];
  const waiters: { pred: (e: RunEvent[]) => boolean; resolve: () => void }[] = [];
  let pong = false;
  ws.on('message', (d) => {
    const msg = JSON.parse(d.toString()) as WsServerMessage;
    if (msg.kind === 'ping') pong = true;
    if (msg.kind === 'events') events.push(...msg.events);
    for (const w of [...waiters]) {
      if (!w.pred(events)) continue;
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve();
    }
  });
  const until = (pred: (e: RunEvent[]) => boolean, ms = 10_000) =>
    new Promise<void>((resolve, reject) => {
      if (pred(events)) return resolve();
      const t = setTimeout(
        () => reject(new Error(`timeout; got ${events.map((e) => e.type).join(',')}`)),
        ms,
      );
      waiters.push({ pred, resolve: () => (clearTimeout(t), resolve()) });
    });
  const open = new Promise<void>((r) => ws.once('open', () => r()));
  return { ws, events, until, open, pong: () => pong };
}

describe('local dev server', () => {
  it('serves the full flow: scenarios → run → live WS events → approval → system state → completion', async () => {
    const { api, port, store } = await start();
    const list = await api('GET', '/scenarios');
    expect(list.status).toBe(200);
    expect(list.headers.get('access-control-allow-origin')).toBe('*');
    expect(list.body.items[0].id).toBe(SCENARIO.id);
    expect((await api('GET', '/config')).body.brand.carrierName).toBe('Accent Air');

    const created = await api('POST', '/runs', { scenarioId: SCENARIO.id, mode: 'agent', speed: 30 });
    expect(created.status).toBe(201);
    const runId = created.body.runId as string;
    const sock = collect(port, runId);
    await sock.open;
    sock.ws.send(JSON.stringify({ action: 'ping' }));

    // The fake runner blocks on the first proposal until a human decides.
    await sock.until((es) => es.some((e) => e.type === 'agent.proposal'));
    const proposal = sock.events.find((e) => e.type === 'agent.proposal') as RunEvent<'agent.proposal'>;
    expect((await store.getApproval(runId, proposal.payload.approvalId))?.status).toBe('pending');
    const decided = await api('POST', `/runs/${runId}/approvals/${proposal.payload.approvalId}`, {
      decision: 'approve',
    });
    expect(decided.status).toBe(200);
    await sock.until((es) => es.some((e) => e.type === 'approval.decision'));

    // Second proposal, then completion.
    await sock.until((es) => es.filter((e) => e.type === 'agent.proposal').length === 2);
    const second = sock.events.filter((e) => e.type === 'agent.proposal')[1] as RunEvent<'agent.proposal'>;
    await api('POST', `/runs/${runId}/approvals/${second.payload.approvalId}`, {
      decision: 'approve',
      selectedOptionId: second.payload.options?.[0]?.id,
    });
    await sock.until((es) => es.some((e) => e.type === 'run.completed'));
    expect(sock.pong()).toBe(true);

    // WS + HTTP hydration agree, gap-free, and the projection matches the stored system state.
    const page = await api('GET', `/runs/${runId}/events?after=0`);
    const all = page.body.events as RunEvent[];
    expect(all.map((e) => e.seq)).toEqual(all.map((_, i) => i + 1));
    // The WS stream is contiguous from the moment it subscribed to the end of the run (earlier events are
    // hydrated over HTTP, as the web client does).
    const liveSeqs = sock.events.map((e) => e.seq);
    expect(liveSeqs).toEqual(all.slice(liveSeqs[0] - 1).map((e) => e.seq));
    const proj = all.reduce<RunProjection>((s, e) => applyEvent(s, e), emptyProjection(runId));
    expect(proj.meta.status).toBe('completed');
    const pss = await api('GET', `/runs/${runId}/systems/pss`);
    expect(pss.status).toBe(200);
    expect(pss.body.entities).toEqual((proj.systems as any).pss);
    expect((await api('GET', `/runs/${runId}`)).body.status).toBe('completed');
    sock.ws.close();
  }, 20_000);

  it('honours control (pause/resume/stop) and twists in the fake runner', async () => {
    const { api, port } = await start('fake');
    const runId = (await api('POST', '/runs', { scenarioId: SCENARIO.id, mode: 'agent', speed: 30 })).body
      .runId;
    const sock = collect(port, runId);
    await sock.open;
    await sock.until((es) => es.some((e) => e.type === 'agent.proposal'));
    await api('POST', `/runs/${runId}/control`, { action: 'pause' });
    await sock.until((es) => es.some((e) => e.type === 'run.paused'));
    await api('POST', `/runs/${runId}/twists`, { text: 'Heavy rain at the station' });
    await api('POST', `/runs/${runId}/control`, { action: 'resume' });
    await sock.until((es) => es.some((e) => e.type === 'run.resumed'));
    await sock.until((es) => es.some((e) => e.type === 'world.twist' && e.payload.source === 'free_text'));
    await api('POST', `/runs/${runId}/control`, { action: 'stop' });
    await sock.until((es) => es.some((e) => e.type === 'run.completed' && e.payload.reason === 'stopped'));
    expect((await api('GET', `/runs/${runId}`)).body.status).toBe('completed');
    sock.ws.close();
  }, 20_000);

  it('rejects WS upgrades without a runId and maps the author stub to 501', async () => {
    const { api, base } = await start();
    const bad = new WebSocket(`${base.replace('http', 'ws')}/ws`);
    await new Promise<void>((r) => bad.once('error', () => r()));
    expect((await api('POST', '/scenarios/author', { text: 'hello' })).status).toBe(501);
  });
});
