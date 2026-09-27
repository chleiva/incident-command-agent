/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * The LIFETIME £10 live-evaluation budget (owner requirement, ADR 0006), enforced in code:
 * - `evals/ledger.json` is committed and APPEND-ONLY: a live invocation appends a `reserved` entry (worst case),
 *   then a `settled` entry with the same id (actual × 1.10). A crash leaves the reservation open: never under-counted.
 * - remaining = cap − Σ settled actualGbp − Σ open reservedGbp.
 * - The cap is a constant; `EVAL_LIFETIME_CAP_GBP` can only LOWER it. There is no override flag.
 * - GBP_USD_RATE comes from config/pricing.json (a conservative, low rate); the env may only lower it further.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { EVAL_RUN_LIMITS, type RunLimits } from '@ica/schema';
import { PRICING, priceFor } from '@ica/run';

export const LIFETIME_CAP_GBP = 10;
export const SAFETY_MARGIN = 1.1;
/** Output tokens a single eval run may produce in the worst case (sizes the per-case RUN_BUDGET_USD). */
export const EVAL_MAX_OUTPUT_TOKENS = 20_000;
/** The judge sees a compact digest (≤ ~10k tokens) plus the rubric; each judgement is capped at this output. */
export const JUDGE_MAX_INPUT_TOKENS = 12_000;
export const JUDGE_MAX_OUTPUT_TOKENS = 4_000;
export const JUDGEMENTS_PER_CASE = 2;

export interface LedgerEntry {
  id: string;
  date: string;
  gitSha: string;
  tier: string;
  caseIds: string[];
  model: string;
  judgeModel: string;
  reservedUsd: number;
  reservedGbp: number;
  actualUsd: number | null;
  actualGbp: number | null;
  status: 'reserved' | 'settled';
  note?: string;
}

export interface Ledger {
  lifetimeCapGbp: number;
  entries: LedgerEntry[];
}

type Env = Record<string, string | undefined>;

/** The effective cap: the constant, or a LOWER positive value from the env. Never higher. */
export function effectiveCapGbp(env: Env = process.env): number {
  const v = Number(env.EVAL_LIFETIME_CAP_GBP);
  return Number.isFinite(v) && v > 0 ? Math.min(LIFETIME_CAP_GBP, v) : LIFETIME_CAP_GBP;
}

/** GBP→USD rate: pricing.json's conservative rate, or a LOWER env value (lower = more pounds counted). */
export function gbpUsdRate(env: Env = process.env): number {
  const base = PRICING.gbpUsdRate;
  const v = Number(env.GBP_USD_RATE);
  return Number.isFinite(v) && v > 0 ? Math.min(base, v) : base;
}

export const usdToGbp = (usd: number, env: Env = process.env) =>
  Math.round((usd / gbpUsdRate(env)) * 1e6) / 1e6;

export function readLedger(path: string): Ledger {
  if (!existsSync(path)) return { lifetimeCapGbp: LIFETIME_CAP_GBP, entries: [] };
  const l = JSON.parse(readFileSync(path, 'utf8')) as Ledger;
  return { lifetimeCapGbp: l.lifetimeCapGbp ?? LIFETIME_CAP_GBP, entries: l.entries ?? [] };
}

/** Append-only write: refuses to drop or alter existing entries. */
export function appendLedger(path: string, entry: LedgerEntry): Ledger {
  const cur = readLedger(path);
  const next: Ledger = { lifetimeCapGbp: LIFETIME_CAP_GBP, entries: [...cur.entries, entry] };
  writeFileSync(path, JSON.stringify(next, null, 2) + '\n');
  return next;
}

export interface LedgerSummary {
  capGbp: number;
  spentGbp: number;
  reservedGbp: number;
  remainingGbp: number;
  openReservations: string[];
}

export function summarise(ledger: Ledger, env: Env = process.env): LedgerSummary {
  const settled = new Map<string, LedgerEntry>();
  for (const e of ledger.entries) if (e.status === 'settled') settled.set(e.id, e);
  const spentGbp = [...settled.values()].reduce((s, e) => s + (e.actualGbp ?? 0), 0);
  const open = ledger.entries.filter((e) => e.status === 'reserved' && !settled.has(e.id));
  const reservedGbp = open.reduce((s, e) => s + e.reservedGbp, 0);
  const capGbp = effectiveCapGbp(env);
  const r = (n: number) => Math.round(n * 1e4) / 1e4;
  return {
    capGbp,
    spentGbp: r(spentGbp),
    reservedGbp: r(reservedGbp),
    remainingGbp: r(Math.max(0, capGbp - spentGbp - reservedGbp)),
    openReservations: open.map((e) => e.id),
  };
}

export interface WorstCase {
  agentUsd: number;
  judgeUsd: number;
  totalUsd: number;
  /** × SAFETY_MARGIN, in pounds. */
  totalGbp: number;
}

/** Worst case of ONE case: eval limits × prices (prompt priced as cache writes) + two judgements. */
export function worstCasePerCase(
  agentModel: string,
  judgeModel: string,
  limits: RunLimits = EVAL_RUN_LIMITS,
  env: Env = process.env,
): WorstCase {
  const a = priceFor(agentModel);
  const j = priceFor(judgeModel);
  const agentUsd =
    (limits.maxInputTokensPerRun * Math.max(a.input, a.cacheWrite) + EVAL_MAX_OUTPUT_TOKENS * a.output) / 1e6;
  const judgeUsd =
    (JUDGEMENTS_PER_CASE *
      (JUDGE_MAX_INPUT_TOKENS * Math.max(j.input, j.cacheWrite) + JUDGE_MAX_OUTPUT_TOKENS * j.output)) /
    1e6;
  const totalUsd = agentUsd + judgeUsd;
  return { agentUsd, judgeUsd, totalUsd, totalGbp: usdToGbp(totalUsd * SAFETY_MARGIN, env) };
}

export interface LivePlan<C extends { id: string; priority: number }> {
  selected: C[];
  skippedByBudget: C[];
  perCase: WorstCase;
  worstGbp: number;
  summary: LedgerSummary;
}

/** Keep the highest-priority cases whose cumulative worst case fits the remaining lifetime budget. */
export function planLive<C extends { id: string; priority: number }>(
  cases: C[],
  ledger: Ledger,
  agentModel: string,
  judgeModel: string,
  env: Env = process.env,
): LivePlan<C> {
  const summary = summarise(ledger, env);
  const perCase = worstCasePerCase(agentModel, judgeModel, EVAL_RUN_LIMITS, env);
  const ordered = [...cases].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  const selected: C[] = [];
  const skippedByBudget: C[] = [];
  let worst = 0;
  for (const c of ordered) {
    if (worst + perCase.totalGbp <= summary.remainingGbp + 1e-12) {
      selected.push(c);
      worst += perCase.totalGbp;
    } else skippedByBudget.push(c);
  }
  return { selected, skippedByBudget, perCase, worstGbp: Math.round(worst * 1e4) / 1e4, summary };
}

export class BudgetRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BudgetRefusal';
  }
}

export interface IntegrityProbe {
  ledgerPath: string;
  reportsDir: string;
  /** `git status --porcelain <ledger>` output (injected in tests). */
  gitStatus?: (path: string) => string;
}

function defaultGitStatus(path: string): string {
  try {
    return execFileSync('git', ['status', '--porcelain', '--', path], { encoding: 'utf8' });
  } catch {
    return '?? git unavailable';
  }
}

/** Refuse a live invocation when the ledger has uncommitted changes, or is missing while live reports exist. */
export function assertLedgerIntegrity(p: IntegrityProbe): void {
  const liveReports = existsSync(p.reportsDir)
    ? readdirSync(p.reportsDir).filter((f) => /-(smoke|core|full)\.json$/.test(f))
    : [];
  if (!existsSync(p.ledgerPath)) {
    if (liveReports.length) {
      throw new BudgetRefusal(
        `evals/ledger.json is missing but live reports exist (${liveReports.join(', ')}). Restore the ledger from git.`,
      );
    }
    return;
  }
  const status = (p.gitStatus ?? defaultGitStatus)(p.ledgerPath).trim();
  if (status) {
    throw new BudgetRefusal(
      `evals/ledger.json has uncommitted changes (${status}). Commit the ledger from the previous live run before spending again.`,
    );
  }
}

export function gitSha(): string {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}
