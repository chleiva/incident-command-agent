/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { foldEvents } from '@ica/schema/browser';
import { describe, expect, it, vi } from 'vitest';
import { S01, viewAt } from '../test/fixtureViews';
import { ApiRequestError, createApiClient } from './api';
import { socketUrl } from './auth';
import { DEFAULT_BRAND, withDefaults } from './brand';
import { agentFeed, eventMarkers, kpiSeries, pendingByUrgency, recentMutations } from './derive';
import { evidenceSections, renderEvidencePdf, sanitise } from './evidencePdf';
import { formatDuration, formatEurCompact, signed } from './format';
import { captionFor, latestCaption } from './narrator';

describe('API client', () => {
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

  it('retries network errors with backoff, never HTTP errors', async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('network down'))
      .mockRejectedValueOnce(new TypeError('network down'))
      .mockResolvedValueOnce(ok({ items: [] }));
    const sleep = vi.fn(async () => {});
    const api = createApiClient({ baseUrl: 'http://x/', transport: { fetch, openSocket: vi.fn() }, sleep });
    await expect(api.listScenarios()).resolves.toEqual({ items: [] });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[300], [600]]);

    const http = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ error: 'nope', code: 'bad' }), { status: 400 }));
    const api2 = createApiClient({
      baseUrl: 'http://x',
      transport: { fetch: http, openSocket: vi.fn() },
      sleep,
    });
    await expect(api2.getRun('r1')).rejects.toBeInstanceOf(ApiRequestError);
    expect(http).toHaveBeenCalledTimes(1);
  });

  it('builds every route with the bearer token', async () => {
    const fetch = vi.fn(async () => ok({}));
    const api = createApiClient({
      baseUrl: 'http://api',
      transport: { fetch, openSocket: vi.fn() },
      getToken: () => 'T',
    });
    await api.listEvents('run 1', 42, 100);
    await api.decideApproval('r', 'ap/1', { decision: 'approve' });
    await api.control('r', { action: 'set_speed', speed: 15 });
    const calls = fetch.mock.calls as unknown as [string, RequestInit][];
    expect(calls[0]![0]).toBe('http://api/runs/run%201/events?after=42&limit=100');
    expect(calls[1]![0]).toBe('http://api/runs/r/approvals/ap%2F1');
    expect((calls[1]![1].headers as Record<string, string>).authorization).toBe('Bearer T');
    expect(JSON.parse(String(calls[2]![1].body))).toEqual({ action: 'set_speed', speed: 15 });
  });

  it('puts runId and token on the WebSocket URL', () => {
    expect(socketUrl('wss://ws.example/prod', 'r1', 'jwt')).toBe('wss://ws.example/prod?runId=r1&token=jwt');
    expect(socketUrl('ws://localhost:8787/ws', 'r1', null)).toBe('ws://localhost:8787/ws?runId=r1');
  });
});

describe('brand pack', () => {
  it('mirrors config/brand.default.json and fills gaps', () => {
    const file = JSON.parse(readFileSync(resolve(process.cwd(), '../../config/brand.default.json'), 'utf8'));
    expect(DEFAULT_BRAND).toEqual(file);
    const merged = withDefaults({ brand: { ...DEFAULT_BRAND, carrierName: 'Other Air' } } as never);
    expect(merged.brand.carrierName).toBe('Other Air');
    expect(merged.stations.length).toBeGreaterThan(5);
  });
});

describe('derivations', () => {
  const view = foldEvents(S01.agent);

  it('builds an agent feed that pairs thoughts, calls, results, blocks and decisions', () => {
    const feed = agentFeed(S01.agent);
    const blocked = feed.find((f) => f.kind === 'tool' && f.blocked);
    expect(blocked && blocked.kind === 'tool' && blocked.call.tool).toBe('defer_defect');
    const proposal = feed.find((f) => f.kind === 'tool' && f.proposal?.approvalId === 'ap-msg-1');
    expect(proposal && proposal.kind === 'tool' && proposal.decision?.decision).toBe('approve');
    expect(feed.some((f) => f.kind === 'report')).toBe(true);
  });

  it('markers cover trigger, decisions, messages, twists, blocks and the end', () => {
    const kinds = new Set(eventMarkers(S01.agent).map((m) => m.kind));
    for (const k of ['trigger', 'decision', 'message', 'twist', 'blocked', 'end']) expect(kinds).toContain(k);
    expect(eventMarkers(S01.baseline).some((m) => m.kind === 'baseline')).toBe(true);
  });

  it('kpi series, urgency order and recent mutations', () => {
    expect(kpiSeries(S01.agent).length).toBeGreaterThan(20);
    const mid = viewAt(S01.agent, 38.5).view;
    expect(pendingByUrgency(mid).map((a) => a.approvalId)).toEqual(['ap-msg-2', 'ap-care-1']);
    expect(recentMutations(S01.agent).size).toBeGreaterThan(0);
    expect(view.pendingApprovalIds).toEqual([]);
  });
});

describe('narrator', () => {
  it('captions from templates, no LLM', () => {
    const page = S01.agent.find(
      (e) =>
        e.type === 'system.mutation' &&
        e.payload.system === 'engineers' &&
        (e.payload.after as { status?: string }).status === 'travelling',
    )!;
    expect(captionFor(page)).toBe('Engineer paged — ETA 9 min');
    const blocked = S01.agent.find((e) => e.type === 'guardrail.blocked')!;
    expect(captionFor(blocked)).toMatch(/^Blocked — Defer defect is reserved for humans/);
    expect(latestCaption(S01.agent)?.text).toBe('Run complete');
  });
});

describe('format', () => {
  it('formats durations, compact euros and signed deltas', () => {
    expect(formatDuration(95)).toBe('1 h 35');
    expect(formatDuration(42)).toBe('42 min');
    expect(formatEurCompact(13300)).toBe('€13k');
    expect(signed(-5)).toBe('−5');
  });
});

describe('evidence pack', () => {
  const view = foldEvents(S01.agent);
  const input = {
    carrierName: 'Accent Air',
    disclaimer: 'Simulated systems · fictional carrier',
    scenarioTitle: S01.scenario.title,
    runId: 'run-demo-s01',
    projection: view,
    events: S01.agent,
    baselineKpis: foldEvents(S01.baseline).kpis,
    evidencePack: Object.values(view.systems.record.evidencePacks)[0] ?? null,
    generatedAt: new Date('2026-06-14T10:00:00Z'),
  };

  it('has decisions with approvers, labelled AI-drafted sections and citations', () => {
    const sections = evidenceSections(input);
    const decisions = sections.find((s) => s.heading.startsWith('Decisions'))!;
    expect(decisions.lines.join('\n')).toMatch(/by Ada Pennick · Certifying Engineer \(B1\)/);
    expect(sections.find((s) => s.heading === 'Passenger messages')!.aiDrafted).toBe(true);
    expect(sections.find((s) => s.heading === 'Report drafts')!.aiDrafted).toBe(true);
    expect(sections.find((s) => s.heading === 'Citations')!.lines.length).toBeGreaterThan(0);
  });

  it('renders a PDF with WinAnsi-safe text', async () => {
    expect(sanitise('a → b ≤ 3 × 4 · €5 “q”')).toBe('a -> b <= 3 x 4 · €5 “q”');
    const bytes = await renderEvidencePdf(input);
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-');
    expect(bytes.length).toBeGreaterThan(2_000);
  });
});
