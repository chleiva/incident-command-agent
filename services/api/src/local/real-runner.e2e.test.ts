/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Integration (local, no LLM, no AWS): the local dev server router + the REAL `executeRun` from @ica/run with the
 * scripted provider, the real domain registry and shipped scenario s01. Start a run over HTTP → live events over the
 * WebSocket → the passenger agent's proposal → approve through the API route → the agent resumes, the message is
 * sent → run completes, and `applyEvent` folds the whole log into the stored system state.
 */
import { executeRun, loadKnowledgeIndex, call, createScriptedProvider, scriptByAgent, step } from '@ica/run';
import { fileURLToPath } from 'node:url';
import { getPublicScenario } from '@ica/scenarios';
import {
  DEFAULT_RUN_LIMITS,
  applyEvent,
  emptyProjection,
  validateEvent,
  type RunEvent,
  type RunProjection,
  type Scenario,
  type WsServerMessage,
} from '@ica/schema';
import { MemoryEventBus, MemoryStore, MemoryTraceStore } from '@ica/store';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { DEFAULT_BRAND, FALLBACK_STATIONS } from '../config/app-config';
import { settingsFromEnv } from '../config/settings';
import { InProcessRunLauncher } from '../runner/launchers';
import { createLocalApp, type LocalApp } from './app';

const FIXTURE_INDEX_DIR = fileURLToPath(new URL('../../../../data/fixtures/index/', import.meta.url));
const S01 = getPublicScenario('s01-pushback-tug-contact') as Scenario;
const REPORT = {
  summary: 'Handled the brief; nothing further outstanding.',
  actionsTaken: [],
  openIssues: [],
  recommendations: [],
  citations: [],
};
const MESSAGE = {
  requestId: '3e2d1c0b-aaaa-4bbb-8ccc-0123456789ab',
  cohortIds: ['c211-general', 'c211-families'],
  channel: 'sms',
  body: 'ACX211 to Palma is delayed while engineers inspect the aircraft. Please stay seated; next update by 08:00.',
};

let app: LocalApp | null = null;
let launcher: InProcessRunLauncher | null = null;
afterEach(async () => {
  await launcher?.close();
  await app?.close();
  app = launcher = null;
});

describe('local dev server with the real runner (scripted provider)', () => {
  it('s01: start → events → proposal → approve via the API → agent resumes → completion; the log folds', async () => {
    const bus = new MemoryEventBus();
    const store = new MemoryStore({ bus });
    const traces = new MemoryTraceStore();
    const scripted = createScriptedProvider(
      scriptByAgent({
        orchestrator: [
          step(
            'Opening.',
            call('open_incident', { title: 'Tug contact AX-MAB', summary: 'Pushback tug contact at MAN.' }),
          ),
          step(
            'Passengers first.',
            call('delegate', { role: 'passenger', brief: 'Inform ACX211 passengers now.' }),
          ),
          step('Done.', call('report', REPORT)),
        ],
        passenger: [
          step('First update.', call('send_passenger_message', MESSAGE, 'tu_msg')),
          step('Reporting.', call('report', REPORT)),
        ],
      }),
    );
    const knowledge = await loadKnowledgeIndex({ source: 'fs', path: FIXTURE_INDEX_DIR, embeddings: 'none' });
    launcher = new InProcessRunLauncher({
      store,
      mode: 'real',
      executeRun,
      deps: async () => ({
        store,
        traces,
        bus,
        knowledge,
        llm: {
          provider: 'scripted',
          model: 'claude-sonnet-5',
          temperature: 0.2,
          maxTokens: 1024,
          limits: DEFAULT_RUN_LIMITS,
        },
        providers: { scripted },
        approvalsPolicy: 'human',
      }),
    });
    app = createLocalApp({
      store,
      bus,
      traces,
      launcher,
      author: { author: async () => Promise.reject(new Error('unused')) },
      screen: async () => ({ verdict: 'clean', findings: [] }),
      publicScenarios: [S01],
      settings: settingsFromEnv({
        AUTH_MODE: 'none',
        LLM_PROVIDER: 'scripted',
        LLM_MODEL: 'claude-sonnet-5',
      }),
      appConfigSource: async () => ({ brand: DEFAULT_BRAND, stations: FALLBACK_STATIONS }),
    });
    const port = await app.listen(0);
    const api = async (method: string, path: string, body?: unknown) => {
      const r = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: body ? { 'content-type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: r.status, body: (await r.json().catch(() => null)) as any };
    };

    const created = await api('POST', '/runs', { scenarioId: S01.id, mode: 'agent', speed: 30 });
    expect(created.status).toBe(201);
    const runId = created.body.runId as string;

    const live: RunEvent[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?runId=${runId}`);
    ws.on('message', (d) => {
      const msg = JSON.parse(d.toString()) as WsServerMessage;
      if (msg.kind === 'events') live.push(...msg.events);
    });
    await new Promise<void>((r) => ws.once('open', () => r()));
    // Hydrate over HTTP (as the web client does: events before the socket opened) and follow live over the WS.
    const all: RunEvent[] = [];
    const hydrate = async () => {
      for (;;) {
        const page = await api('GET', `/runs/${runId}/events?after=${all.at(-1)?.seq ?? 0}`);
        all.push(...(page.body.events as RunEvent[]));
        if (!page.body.events.length || all.at(-1)!.seq >= page.body.lastSeq) return;
      }
    };
    const until = async (pred: (es: RunEvent[]) => boolean, ms = 20_000) => {
      const t0 = Date.now();
      for (;;) {
        await hydrate();
        if (pred(all)) return;
        if (Date.now() - t0 > ms) throw new Error(`timeout; got ${all.map((e) => e.type).join(',')}`);
        await new Promise((r) => setTimeout(r, 50));
      }
    };

    await until((es) => es.some((e) => e.type === 'agent.proposal'));
    const proposal = all.find((e) => e.type === 'agent.proposal') as RunEvent<'agent.proposal'>;
    expect(proposal.payload.tool).toBe('send_passenger_message');
    expect((await api('GET', `/runs/${runId}/approvals`)).status).toBeLessThan(500);
    // The duty manager thinks for a while: the agent stays blocked while the world keeps ticking (speed 30:
    // one sim minute every 2 s).
    await until(
      (es) => es.filter((e) => e.type === 'world.tick').length >= 1 && es.at(-1)!.seq > proposal.seq,
    );
    expect(all.some((e) => e.seq > proposal.seq && e.agentRunId === proposal.agentRunId)).toBe(false);
    const decided = await api('POST', `/runs/${runId}/approvals/${proposal.payload.approvalId}`, {
      decision: 'approve',
    });
    expect(decided.status).toBe(200);
    // A second decision on the same approval is refused.
    expect(
      (await api('POST', `/runs/${runId}/approvals/${proposal.payload.approvalId}`, { decision: 'reject' }))
        .status,
    ).toBe(409);

    await until((es) => es.some((e) => e.type === 'run.completed' || e.type === 'run.failed'));
    await new Promise((r) => setTimeout(r, 50));
    ws.close();

    expect(all.map((e) => e.seq)).toEqual(all.map((_, i) => i + 1));
    // The live WS stream is contiguous from the moment it subscribed to the end of the run.
    expect(live.length).toBeGreaterThan(0);
    expect(live.map((e) => e.seq)).toEqual(all.slice(live[0].seq - 1).map((e) => e.seq));
    expect(live.some((e) => e.type === 'approval.decision')).toBe(true);
    for (const e of all) expect(validateEvent(e).ok).toBe(true);
    const types = new Set(all.map((e) => e.type));
    for (const t of [
      'run.created',
      'world.tick',
      'kpi.update',
      'agent.tool_call',
      'approval.decision',
      'run.completed',
    ])
      expect(types.has(t as RunEvent['type']), t).toBe(true);
    const result = all.find(
      (e): e is RunEvent<'agent.tool_result'> =>
        e.type === 'agent.tool_result' && e.payload.toolCallId === 'tu_msg',
    );
    expect(result?.payload.ok).toBe(true);
    expect(result!.seq).toBeGreaterThan(all.find((e) => e.type === 'approval.decision')!.seq);

    const proj = all.reduce<RunProjection>((s, e) => applyEvent(s, e), emptyProjection(runId));
    expect(proj.meta.status).toBe('completed');
    const [msg] = Object.values(proj.systems.pss.messages);
    expect(msg).toMatchObject({ status: 'sent', approvedBy: { kind: 'human' } });
    // The fold of the whole log equals the persisted mock state.
    const stored = await api('GET', `/runs/${runId}/systems/pss`);
    expect(stored.status).toBe(200);
    expect(stored.body.entities).toEqual(proj.systems.pss);
    // The evidence export route serves the whole log.
    const exported = await api('GET', `/runs/${runId}/export`);
    expect(exported.status).toBe(200);
    expect((exported.body.trace as RunEvent[]).length).toBe(all.length);
  }, 60_000);
});
