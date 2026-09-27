/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** Reports (`evals/reports/{YYYY-MM-DD}-{tier}.json/.md`), the diff against the previous report, and the CI gate. */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { EvalReport } from '@ica/schema';
import type { LedgerSummary } from './budget';
import type { CaseResult, LayerName } from './harness';

export const LAYERS: LayerName[] = ['trajectory', 'outcome', 'grounding', 'judge', 'robustness', 'cost'];
export const JUDGE_DROP_LIMIT = 0.3;

export interface FullEvalReport extends EvalReport {
  /** Additions (EvalReport is open for task 02 fields). */
  live: boolean;
  skippedByBudget: string[];
  judgeByDimension: Record<string, number | null>;
  results: CaseResult[];
  diff: {
    previousId: string | null;
    hardAssertionPassRateDelta: number | null;
    judgeMeanDelta: number | null;
    newlyFailing: string[];
    newlyPassing: string[];
  };
  gate: { passed: boolean; reasons: string[] };
}

const round = (n: number, d = 4) => Math.round(n * 10 ** d) / 10 ** d;

export function buildReport(opts: {
  tier: string;
  live: boolean;
  gitSha?: string;
  results: CaseResult[];
  skippedByBudget?: string[];
  spendUsd: number;
  spendGbp: number;
  ledger: LedgerSummary;
  previous: FullEvalReport | null;
  now?: Date;
}): FullEvalReport {
  const now = opts.now ?? new Date();
  const ran = opts.results.filter((r) => !r.skippedReason);
  const passRateByLayer: Record<string, number> = {};
  for (const l of LAYERS) {
    const xs = ran.map((r) => r.layers[l]).filter((x): x is boolean => typeof x === 'boolean');
    if (xs.length) passRateByLayer[l] = round(xs.filter(Boolean).length / xs.length);
  }
  const hard = ran.flatMap((r) => r.assertions.filter((a) => a.hard));
  const hardAssertionPassRate = hard.length ? round(hard.filter((a) => a.passed).length / hard.length) : 1;
  const judged = ran.map((r) => r.judge?.mean).filter((x): x is number => typeof x === 'number');
  const judgeMean = judged.length ? round(judged.reduce((a, b) => a + b, 0) / judged.length, 2) : null;
  const judgeByDimension: Record<string, number | null> = {};
  for (const r of ran) {
    for (const [d, v] of Object.entries(r.judge?.perDimension ?? {})) {
      if (typeof v !== 'number') continue;
      judgeByDimension[d] = (judgeByDimension[d] ?? 0) + v;
    }
  }
  for (const d of Object.keys(judgeByDimension)) {
    const n = ran.filter((r) => typeof r.judge?.perDimension?.[d as never] === 'number').length;
    judgeByDimension[d] = n ? round((judgeByDimension[d] as number) / n, 2) : null;
  }

  const prev = opts.previous;
  const prevPassed = new Map((prev?.cases ?? []).map((c) => [c.caseId, c.passed]));
  const newlyFailing = ran.filter((r) => !r.passed && prevPassed.get(r.caseId) === true).map((r) => r.caseId);
  const newlyPassing = ran.filter((r) => r.passed && prevPassed.get(r.caseId) === false).map((r) => r.caseId);
  const hardDelta = prev ? round(hardAssertionPassRate - prev.hardAssertionPassRate) : null;
  const judgeDelta =
    prev && prev.judgeMean !== null && judgeMean !== null ? round(judgeMean - prev.judgeMean, 2) : null;
  const reasons: string[] = [];
  if (hardDelta !== null && hardDelta < -1e-9)
    reasons.push(`hard-assertion pass rate regressed by ${Math.abs(hardDelta)}`);
  if (newlyFailing.length) reasons.push(`cases newly failing hard assertions: ${newlyFailing.join(', ')}`);
  if (judgeDelta !== null && judgeDelta < -JUDGE_DROP_LIMIT)
    reasons.push(`judge mean dropped by ${Math.abs(judgeDelta)} (> ${JUDGE_DROP_LIMIT})`);

  const id = `${now.toISOString().slice(0, 10)}-${opts.tier}`;
  const report: FullEvalReport = {
    id,
    createdAt: now.toISOString(),
    tier: opts.tier,
    ...(opts.gitSha ? { gitSha: opts.gitSha } : {}),
    caseCount: opts.results.length,
    passRateByLayer,
    hardAssertionPassRate,
    judgeMean,
    spend: { usd: round(opts.spendUsd), gbp: round(opts.spendGbp) },
    ledger: {
      lifetimeCapGbp: opts.ledger.capGbp,
      spentGbp: opts.ledger.spentGbp,
      reservedGbp: opts.ledger.reservedGbp,
      remainingGbp: opts.ledger.remainingGbp,
    },
    cases: opts.results.map((r) => ({
      caseId: r.caseId,
      scenarioId: r.scenarioId,
      passed: r.passed,
      ...(r.skippedReason ? { skippedReason: r.skippedReason } : {}),
    })),
    live: opts.live,
    skippedByBudget: opts.skippedByBudget ?? [],
    judgeByDimension,
    results: opts.results.map(({ digest: _d, ...r }) => r),
    diff: {
      previousId: prev?.id ?? null,
      hardAssertionPassRateDelta: hardDelta,
      judgeMeanDelta: judgeDelta,
      newlyFailing,
      newlyPassing,
    },
    gate: { passed: reasons.length === 0, reasons },
  };
  report.markdown = renderMarkdown(report);
  return report;
}

export function renderMarkdown(r: FullEvalReport): string {
  const pct = (x: number | undefined) => (x === undefined ? '—' : `${Math.round(x * 100)}%`);
  const lines = [
    `# Eval report ${r.id}`,
    '',
    `Tier **${r.tier}**${r.live ? ' (LIVE)' : ' (£0)'} · ${r.createdAt} · git ${r.gitSha ?? '—'} · ${r.caseCount} cases (${r.cases.filter((c) => c.skippedReason).length} skipped)`,
    '',
    `**Gate: ${r.gate.passed ? 'PASS' : 'FAIL'}**${r.gate.reasons.length ? ` — ${r.gate.reasons.join('; ')}` : ''}`,
    '',
    '| Layer | Pass rate |',
    '|---|---|',
    ...LAYERS.map((l) => `| ${l} | ${pct(r.passRateByLayer[l])} |`),
    `| hard assertions | ${pct(r.hardAssertionPassRate)} |`,
    '',
    `Judge mean: ${r.judgeMean ?? '—'}${
      Object.keys(r.judgeByDimension).length
        ? ` (${Object.entries(r.judgeByDimension)
            .map(([d, v]) => `${d} ${v ?? '—'}`)
            .join(', ')})`
        : ''
    }`,
    '',
    `Spend this invocation: $${r.spend.usd} / £${r.spend.gbp}. Lifetime ledger: £${r.ledger.spentGbp} spent, £${r.ledger.reservedGbp} reserved, £${r.ledger.remainingGbp} remaining of £${r.ledger.lifetimeCapGbp}.`,
    r.skippedByBudget.length ? `Skipped by budget: ${r.skippedByBudget.join(', ')}` : '',
    '',
    `Diff vs ${r.diff.previousId ?? '(no previous report)'}: hard Δ ${r.diff.hardAssertionPassRateDelta ?? '—'}, judge Δ ${r.diff.judgeMeanDelta ?? '—'}${r.diff.newlyFailing.length ? `, newly failing: ${r.diff.newlyFailing.join(', ')}` : ''}${r.diff.newlyPassing.length ? `, newly passing: ${r.diff.newlyPassing.join(', ')}` : ''}`,
    '',
    '## Cases',
    '',
    '| Case | Result | Run | Failed assertions | Judge | Δ satisfaction | Δ cost € | Cost $ |',
    '|---|---|---|---|---|---|---|---|',
    ...r.results.map((c) => {
      if (c.skippedReason) return `| ${c.caseId} | skipped | — | ${c.skippedReason} | — | — | — | — |`;
      const failed = c.assertions
        .filter((a) => !a.passed)
        .map((a) => `${a.hard ? '**' : ''}${a.id}${a.hard ? '**' : ''}`);
      return `| ${c.caseId} | ${c.passed ? 'pass' : 'FAIL'} | ${c.runStatus ?? '—'}/${c.runReason ?? '—'} | ${failed.join(', ') || '—'} | ${c.judge?.mean ?? '—'} | ${c.outcome?.delta.satisfaction ?? '—'} | ${c.outcome?.delta.totalCostEur ?? '—'} | ${c.cost ? c.cost.usd.toFixed(4) : '—'} |`;
    }),
    '',
  ];
  return lines.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n');
}

/** The most recent report of a tier (the gate compares against it). */
export function previousReport(dir: string, tier: string): FullEvalReport | null {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(`-${tier}.json`) && /^\d{4}-\d{2}-\d{2}-/.test(f))
    .sort();
  const last = files.at(-1);
  return last ? (JSON.parse(readFileSync(join(dir, last), 'utf8')) as FullEvalReport) : null;
}
