/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createScriptedProvider, demoScript } from '@ica/run';
import {
  BudgetRefusal,
  LIFETIME_CAP_GBP,
  appendLedger,
  assertLedgerIntegrity,
  effectiveCapGbp,
  gbpUsdRate,
  planLive,
  readLedger,
  summarise,
  worstCasePerCase,
  type LedgerEntry,
} from './budget';
import { loadCases } from './case';
import { PATHS } from './harness';
import { DIMENSIONS } from './judge';
import { runTier, type TierDeps } from './run-tier';

const ENV = {}; // no env overrides: cap 10, pricing.json rate

function entry(
  id: string,
  status: 'reserved' | 'settled',
  gbp: number,
  actual: number | null = null,
): LedgerEntry {
  return {
    id,
    date: '2026-09-26T00:00:00Z',
    gitSha: 'abc',
    tier: 'smoke',
    caseIds: ['s01-base'],
    model: 'claude-sonnet-5',
    judgeModel: 'claude-opus-5-5',
    reservedUsd: gbp * 1.2,
    reservedGbp: gbp,
    actualUsd: actual === null ? null : actual * 1.2,
    actualGbp: actual,
    status,
  };
}

function tmp(): {
  dir: string;
  ledger: string;
  reports: string;
  traces: string;
  judge: string;
  events: string;
} {
  const dir = mkdtempSync(join(tmpdir(), 'ica-evals-'));
  const p = {
    dir,
    ledger: join(dir, 'ledger.json'),
    reports: join(dir, 'reports'),
    traces: join(dir, 'fixtures', 'traces'),
    judge: join(dir, 'fixtures', 'judge'),
    events: join(dir, 'fixtures', 'events'),
  };
  mkdirSync(p.reports, { recursive: true });
  writeFileSync(p.ledger, JSON.stringify({ lifetimeCapGbp: 10, entries: [] }));
  return p;
}

describe('lifetime budget: cap, rate and ledger arithmetic', () => {
  it('the cap is a constant that the env can only lower', () => {
    expect(LIFETIME_CAP_GBP).toBe(10);
    expect(effectiveCapGbp({})).toBe(10);
    expect(effectiveCapGbp({ EVAL_LIFETIME_CAP_GBP: '4' })).toBe(4);
    expect(effectiveCapGbp({ EVAL_LIFETIME_CAP_GBP: '25' })).toBe(10);
    expect(effectiveCapGbp({ EVAL_LIFETIME_CAP_GBP: '-1' })).toBe(10);
    expect(effectiveCapGbp({ EVAL_LIFETIME_CAP_GBP: 'lots' })).toBe(10);
  });

  it('the GBP rate is the conservative pricing.json rate, lowerable only', () => {
    expect(gbpUsdRate({})).toBe(1.2);
    expect(gbpUsdRate({ GBP_USD_RATE: '1.5' })).toBe(1.2);
    expect(gbpUsdRate({ GBP_USD_RATE: '1.1' })).toBe(1.1);
  });

  it('accumulates across invocations: remaining = cap − settled − open reservations', () => {
    const p = tmp();
    appendLedger(p.ledger, entry('a', 'reserved', 4));
    appendLedger(p.ledger, entry('a', 'settled', 4, 1.5));
    appendLedger(p.ledger, entry('b', 'reserved', 3));
    appendLedger(p.ledger, entry('b', 'settled', 3, 2));
    appendLedger(p.ledger, entry('c', 'reserved', 2)); // crashed: never settled
    const s = summarise(readLedger(p.ledger), ENV);
    expect(s.spentGbp).toBe(3.5);
    expect(s.reservedGbp).toBe(2);
    expect(s.remainingGbp).toBe(4.5);
    expect(s.openReservations).toEqual(['c']);
    // append-only
    expect(readLedger(p.ledger).entries.map((e) => `${e.id}:${e.status}`)).toEqual([
      'a:reserved',
      'a:settled',
      'b:reserved',
      'b:settled',
      'c:reserved',
    ]);
  });

  it('worst case per case is priced from pricing.json with the 1.10 margin (smoke ≈ £3–5)', () => {
    const w = worstCasePerCase('claude-sonnet-5', 'claude-opus-5-5', undefined, ENV);
    // agent: 80k × $2.5 + 20k × $10 = $0.40; judge: 2 × (12k × $5 + 4k × $20) = $0.28
    expect(w.agentUsd).toBeCloseTo(0.4, 6);
    expect(w.judgeUsd).toBeCloseTo(0.28, 6);
    expect(w.totalGbp).toBeCloseTo((0.68 * 1.1) / 1.2, 5);
    expect(6 * w.totalGbp).toBeGreaterThan(3);
    expect(6 * w.totalGbp).toBeLessThan(5);
  });

  it('truncates to the highest-priority cases that fit; nothing fits → empty selection', () => {
    const cases = [
      { id: 'p3', priority: 3 },
      { id: 'p1', priority: 1 },
      { id: 'p2', priority: 2 },
    ];
    const per = worstCasePerCase('claude-sonnet-5', 'claude-opus-5-5', undefined, ENV).totalGbp;
    const ledger = { lifetimeCapGbp: 10, entries: [entry('x', 'settled', 0, 10 - 2.5 * per)] };
    const plan = planLive(cases, ledger, 'claude-sonnet-5', 'claude-opus-5-5', ENV);
    expect(plan.selected.map((c) => c.id)).toEqual(['p1', 'p2']);
    expect(plan.skippedByBudget.map((c) => c.id)).toEqual(['p3']);
    const broke = planLive(
      cases,
      { lifetimeCapGbp: 10, entries: [entry('y', 'settled', 0, 9.99)] },
      'claude-sonnet-5',
      'claude-opus-5-5',
      ENV,
    );
    expect(broke.selected).toHaveLength(0);
  });

  it('refuses when the ledger has uncommitted changes, or is missing while live reports exist', () => {
    const p = tmp();
    expect(() =>
      assertLedgerIntegrity({ ledgerPath: p.ledger, reportsDir: p.reports, gitStatus: () => '' }),
    ).not.toThrow();
    expect(() =>
      assertLedgerIntegrity({
        ledgerPath: p.ledger,
        reportsDir: p.reports,
        gitStatus: () => ' M evals/ledger.json',
      }),
    ).toThrow(/uncommitted/);
    writeFileSync(join(p.reports, '2026-09-20-smoke.json'), '{}');
    expect(() =>
      assertLedgerIntegrity({ ledgerPath: join(p.dir, 'missing.json'), reportsDir: p.reports }),
    ).toThrow(/missing/);
  });
});

describe('runTier: live spend guard (fake providers, no network)', () => {
  const verdict = JSON.stringify(Object.fromEntries(DIMENSIONS.map((d) => [d, { score: 4, why: 'x' }])));
  const fx = loadCases(PATHS.cases)
    .filter((c) => c.id === 'fx-runtime-smoke')
    .map((c) => ({ ...c, tier: ['smoke' as const] }));

  const deps = (p: ReturnType<typeof tmp>, extra: Partial<TierDeps> = {}): TierDeps => ({
    cases: fx,
    log: () => undefined,
    confirm: async () => true,
    paths: { ledger: p.ledger, reports: p.reports, traces: p.traces, judge: p.judge, events: p.events },
    gitStatus: () => '',
    writeReport: false,
    liveProviders: async () => ({
      agent: { anthropic: createScriptedProvider(demoScript(), { id: 'anthropic' }) },
      judge: createScriptedProvider(() => ({ text: verdict }), { id: 'anthropic' }),
    }),
    ...extra,
  });

  it('--live is required for any spend; --live is refused on free tiers', async () => {
    const p = tmp();
    let built = 0;
    const d = deps(p, { liveProviders: async () => (built++, undefined) as never });
    await expect(runTier({ tier: 'smoke', live: false, yes: true }, d)).rejects.toBeInstanceOf(BudgetRefusal);
    await expect(runTier({ tier: 'replay', live: true, yes: true }, d)).rejects.toThrow(/only valid/);
    expect(built).toBe(0);
    expect(readLedger(p.ledger).entries).toHaveLength(0);
  });

  it('refuses without confirmation, before reserving anything', async () => {
    const p = tmp();
    await expect(
      runTier({ tier: 'smoke', live: true, yes: false }, deps(p, { confirm: async () => false })),
    ).rejects.toThrow(/cancelled/);
    expect(readLedger(p.ledger).entries).toHaveLength(0);
  });

  it('refuses when the worst case exceeds the remaining lifetime budget', async () => {
    const p = tmp();
    appendLedger(p.ledger, entry('old', 'settled', 0, 9.9));
    await expect(runTier({ tier: 'smoke', live: true, yes: true }, deps(p))).rejects.toThrow(
      /exceeds the remaining lifetime budget/,
    );
    expect(readLedger(p.ledger).entries).toHaveLength(1);
  });

  it('refuses on a dirty ledger', async () => {
    const p = tmp();
    await expect(
      runTier({ tier: 'smoke', live: true, yes: true }, deps(p, { gitStatus: () => ' M ledger.json' })),
    ).rejects.toThrow(/uncommitted/);
  });

  it('reserves before any call, settles with actual × 1.10 and records fixtures', async () => {
    const p = tmp();
    let reservedBeforeCall = false;
    const d = deps(p, {
      liveProviders: async () => {
        reservedBeforeCall = readLedger(p.ledger).entries.some((e) => e.status === 'reserved');
        return {
          agent: { anthropic: createScriptedProvider(demoScript(), { id: 'anthropic' }) },
          judge: createScriptedProvider(() => ({ text: verdict }), { id: 'anthropic' }),
        };
      },
    });
    const { report, ledgerEntry } = await runTier({ tier: 'smoke', live: true, yes: true }, d);
    expect(reservedBeforeCall).toBe(true);
    const entries = readLedger(p.ledger).entries;
    expect(entries.map((e) => e.status)).toEqual(['reserved', 'settled']);
    expect(entries[1].id).toBe(entries[0].id);
    // agents: 7 calls × (1000 in × $2 + 100 out × $10)/1e6 = $0.021; judge (Opus 5.5): 2 × (1000 × $4 + 100 × $20)/1e6
    expect(ledgerEntry!.actualUsd).toBeCloseTo((0.021 + 2 * 0.006) * 1.1, 6);
    expect(ledgerEntry!.actualGbp!).toBeLessThan(entries[0].reservedGbp);
    expect(report.live).toBe(true);
    expect(report.results[0].judge?.mean).toBe(4);
    expect(JSON.parse(readFileSync(join(p.judge, 'fx-runtime-smoke.json'), 'utf8')).judgements).toHaveLength(
      2,
    );
    // a second invocation sees the first one's spend (lifetime accumulation)
    const s = summarise(readLedger(p.ledger), ENV);
    expect(s.spentGbp).toBeCloseTo(ledgerEntry!.actualGbp!, 3);
    expect(s.reservedGbp).toBe(0);
  });

  it('a crash after reserving leaves the reservation standing (never under-counted)', async () => {
    const p = tmp();
    const d = deps(p, {
      liveProviders: async () => {
        throw new Error('process died');
      },
    });
    await expect(runTier({ tier: 'smoke', live: true, yes: true }, d)).rejects.toThrow(/process died/);
    const s = summarise(readLedger(p.ledger), ENV);
    expect(s.openReservations).toHaveLength(1);
    expect(s.reservedGbp).toBeGreaterThan(0);
    expect(s.remainingGbp).toBeCloseTo(10 - s.reservedGbp, 4);
  });
});
