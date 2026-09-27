/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * One eval invocation. Free tiers (`replay`, `baseline`) never spend. Live tiers (`smoke`, `core`, `full`) require
 * `--live`, pass the ledger integrity check, are planned against the REMAINING LIFETIME budget (truncated to the
 * highest-priority cases that fit), need confirmation, reserve the worst case in the ledger BEFORE any call and
 * settle it with the actual cost × 1.10 afterwards. A crash leaves the reservation standing.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { writeJson } from './fsutil';
import { join } from 'node:path';
import type { LlmProvider, ProviderId, Store, WallClock } from '@ica/schema';
import { EnvSecretStore } from '@ica/store';
import type { Registry } from '@ica/run';
import {
  BudgetRefusal,
  SAFETY_MARGIN,
  appendLedger,
  assertLedgerIntegrity,
  gitSha,
  planLive,
  readLedger,
  summarise,
  usdToGbp,
  type LedgerEntry,
} from './budget';
import type { EvalCase } from './case';
import {
  PATHS,
  evaluateAgentRun,
  evaluateBaselineRun,
  runAgentCase,
  runBaselineCase,
  saveRecording,
  scenarioOrSkip,
  type AgentProviderMode,
  type CaseResult,
} from './harness';
import { DEFAULT_JUDGE_MODEL, judge, loadRubric, type JudgeResult } from './judge';
import { buildReport, previousReport, type FullEvalReport } from './report';

export const FREE_TIERS = ['replay', 'baseline'] as const;
export const LIVE_TIERS = ['smoke', 'core', 'full'] as const;
export type Tier = (typeof FREE_TIERS)[number] | (typeof LIVE_TIERS)[number];
export const PARALLELISM = 3;

export interface TierOptions {
  tier: Tier;
  live: boolean;
  caseIds?: string[];
  yes: boolean;
  agentModel?: string;
  judgeModel?: string;
  env?: Record<string, string | undefined>;
}

export interface TierDeps {
  cases: EvalCase[];
  log: (line: string) => void;
  confirm: (question: string) => Promise<boolean>;
  paths?: Partial<typeof PATHS>;
  gitStatus?: (path: string) => string;
  /** Live providers (tests inject fakes; the CLI builds Anthropic from ANTHROPIC_API_KEY). */
  liveProviders?: () => Promise<{ agent: Partial<Record<ProviderId, LlmProvider>>; judge: LlmProvider }>;
  /** Scripted mode (fixture recording): agent + judge providers. */
  scripted?: { agent: (clock: WallClock) => LlmProvider; judge: LlmProvider };
  registry?: Registry;
  writeReport?: boolean;
  publish?: Store;
  now?: Date;
}

async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]);
      }
    }),
  );
  return out;
}

export function selectCases(
  all: EvalCase[],
  tier: Tier,
  caseIds: string[] | undefined,
  tracesDir: string,
): EvalCase[] {
  let cases = all;
  if (caseIds?.length) {
    const unknown = caseIds.filter((id) => !all.some((c) => c.id === id));
    if (unknown.length) throw new Error(`unknown case ids: ${unknown.join(', ')}`);
    cases = all.filter((c) => caseIds.includes(c.id));
  } else if (tier === 'replay') {
    cases = all.filter((c) => existsSync(join(tracesDir, c.id)) || c.kind === 'author');
  } else if (tier !== 'baseline') {
    cases = all.filter((c) => c.tier.includes(tier));
  }
  // baseline: every case (including the fixture case)
  return cases;
}

async function readJudgeFixture(dir: string, caseId: string): Promise<JudgeResult | null> {
  const f = join(dir, `${caseId}.json`);
  if (!existsSync(f)) return null;
  return JSON.parse(await readFile(f, 'utf8')) as JudgeResult;
}

export interface TierOutcome {
  report: FullEvalReport;
  ledgerEntry?: LedgerEntry;
}

export async function runTier(opts: TierOptions, deps: TierDeps): Promise<TierOutcome> {
  const env = opts.env ?? process.env;
  const paths = { ...PATHS, ...deps.paths };
  const isLive = (LIVE_TIERS as readonly string[]).includes(opts.tier);
  const scripted = !!deps.scripted;
  if (isLive && !opts.live && !scripted) {
    throw new BudgetRefusal(
      `tier '${opts.tier}' makes live LLM calls and spends the lifetime budget: add --live (and confirm).`,
    );
  }
  if (opts.live && !isLive)
    throw new BudgetRefusal(`--live is only valid with --tier smoke|core|full (got ${opts.tier}).`);
  const agentModel = opts.agentModel ?? env.LLM_MODEL ?? 'claude-sonnet-5';
  const judgeModel = opts.judgeModel ?? env.EVAL_JUDGE_MODEL ?? DEFAULT_JUDGE_MODEL;
  const rubric = loadRubric(paths.rubrics);
  let cases = selectCases(deps.cases, opts.tier, opts.caseIds, paths.traces);
  let skippedByBudget: string[] = [];
  let reservation: LedgerEntry | undefined;
  let perCaseAgentUsd = 2;

  if (opts.live) {
    assertLedgerIntegrity({ ledgerPath: paths.ledger, reportsDir: paths.reports, gitStatus: deps.gitStatus });
    const plan = planLive(cases, readLedger(paths.ledger), agentModel, judgeModel, env);
    perCaseAgentUsd = plan.perCase.agentUsd;
    deps.log(
      [
        `LIVE evaluation plan (tier ${opts.tier}): agents ${agentModel}, judge ${judgeModel} (×2 judgements)`,
        `  worst case per case: $${plan.perCase.totalUsd.toFixed(3)} → £${plan.perCase.totalGbp.toFixed(3)} incl. ×${SAFETY_MARGIN} margin`,
        `  selected (${plan.selected.length}): ${plan.selected.map((c) => c.id).join(', ') || '—'}`,
        `  skipped by budget (${plan.skippedByBudget.length}): ${plan.skippedByBudget.map((c) => c.id).join(', ') || '—'}`,
        `  worst case total: £${plan.worstGbp.toFixed(3)} · lifetime remaining: £${plan.summary.remainingGbp.toFixed(3)} of £${plan.summary.capGbp}`,
      ].join('\n'),
    );
    if (!plan.selected.length) {
      throw new BudgetRefusal(
        `refused: the worst case of even one case (£${plan.perCase.totalGbp.toFixed(3)}) exceeds the remaining lifetime budget (£${plan.summary.remainingGbp.toFixed(3)}).`,
      );
    }
    if (
      !opts.yes &&
      !(await deps.confirm(
        `Spend up to £${plan.worstGbp.toFixed(3)} of the lifetime £${plan.summary.capGbp} budget?`,
      ))
    ) {
      throw new BudgetRefusal('cancelled: no confirmation.');
    }
    cases = plan.selected;
    skippedByBudget = plan.skippedByBudget.map((c) => c.id);
    const worstUsd = plan.selected.length * plan.perCase.totalUsd * SAFETY_MARGIN;
    reservation = {
      id: `live-${(deps.now ?? new Date()).toISOString().replace(/[:.]/g, '-')}`,
      date: (deps.now ?? new Date()).toISOString(),
      gitSha: gitSha(),
      tier: opts.tier,
      caseIds: plan.selected.map((c) => c.id),
      model: agentModel,
      judgeModel,
      reservedUsd: Math.round(worstUsd * 1e6) / 1e6,
      reservedGbp: usdToGbp(worstUsd, env),
      actualUsd: null,
      actualGbp: null,
      status: 'reserved',
    };
    appendLedger(paths.ledger, reservation); // BEFORE any live call
  }

  const live = opts.live ? await deps.liveProviders?.() : undefined;
  if (opts.live && !live) throw new Error('live providers unavailable');
  let spentUsd = 0;

  const results = await pool(cases, PARALLELISM, async (c): Promise<CaseResult> => {
    const { scenario, skip } = scenarioOrSkip(c);
    if (skip) {
      return {
        caseId: c.id,
        scenarioId: c.scenarioId,
        adversarial: !!c.adversarial,
        passed: false,
        skippedReason: skip,
        assertions: [],
        layers: {},
      };
    }
    try {
      if (opts.tier === 'baseline') {
        if (c.kind === 'author') {
          return {
            caseId: c.id,
            scenarioId: c.scenarioId,
            adversarial: true,
            passed: false,
            skippedReason: 'author case has no baseline',
            assertions: [],
            layers: {},
          };
        }
        return evaluateBaselineRun(c, await runBaselineCase(c, scenario!, deps.registry));
      }
      const mode: AgentProviderMode = scripted ? 'scripted' : opts.live ? 'live' : 'replay';
      const agent = await runAgentCase(c, scenario, {
        providerMode: mode,
        traceDir: join(paths.traces, c.id),
        providers: live?.agent,
        scriptedFactory: deps.scripted?.agent,
        llm: { model: agentModel, provider: scripted ? 'scripted' : opts.live ? 'anthropic' : 'replay' },
        secrets: new EnvSecretStore(env),
        registry: deps.registry,
        budgetUsd: opts.live ? perCaseAgentUsd : undefined,
      });
      const baseline =
        scenario && c.kind !== 'author' ? await runBaselineCase(c, scenario, deps.registry) : null;
      const result = evaluateAgentRun(c, scenario, agent, baseline, opts.live ? perCaseAgentUsd : Infinity);
      let judged: JudgeResult | null = null;
      if (result.digest && c.kind !== 'author') {
        if (opts.live || scripted) {
          judged = await judge({
            caseId: c.id,
            digest: result.digest,
            rubric,
            provider: scripted ? deps.scripted!.judge : live!.judge,
            model: judgeModel,
            synthetic: scripted,
          });
        } else {
          judged = await readJudgeFixture(paths.judge, c.id);
        }
      }
      result.judge = judged;
      result.layers.judge = judged?.mean == null ? null : judged.mean >= 3.5;
      if (opts.live) spentUsd += (agent.result?.totals?.costUsd ?? 0) + (judged?.usd ?? 0);
      if (opts.live || scripted) await saveRecording(c.id, agent, judged, paths);
      return result;
    } catch (err) {
      return {
        caseId: c.id,
        scenarioId: c.scenarioId,
        adversarial: !!c.adversarial,
        passed: false,
        assertions: [
          {
            id: 'case_error',
            layer: 'trajectory',
            hard: true,
            passed: false,
            detail: String((err as Error).message).slice(0, 300),
          },
        ],
        layers: { trajectory: false },
      };
    }
  });

  let settled: LedgerEntry | undefined;
  if (reservation) {
    const actualUsd = Math.round(spentUsd * SAFETY_MARGIN * 1e6) / 1e6;
    settled = { ...reservation, status: 'settled', actualUsd, actualGbp: usdToGbp(actualUsd, env) };
    appendLedger(paths.ledger, settled);
    deps.log(
      `Settled: actual $${actualUsd.toFixed(4)} (×${SAFETY_MARGIN}) = £${settled.actualGbp!.toFixed(4)}. COMMIT evals/ledger.json AND evals/fixtures NOW.`,
    );
  }

  const previous = previousReport(paths.reports, opts.tier);
  const report = buildReport({
    tier: opts.tier,
    live: opts.live,
    gitSha: gitSha(),
    results,
    skippedByBudget,
    spendUsd: opts.live ? Math.round(spentUsd * SAFETY_MARGIN * 1e6) / 1e6 : 0,
    spendGbp: opts.live ? usdToGbp(spentUsd * SAFETY_MARGIN, env) : 0,
    ledger: summarise(readLedger(paths.ledger), env),
    previous,
    now: deps.now,
  });
  if (deps.writeReport !== false) {
    await mkdir(paths.reports, { recursive: true });
    await writeJson(join(paths.reports, `${report.id}.json`), report);
    await writeFile(join(paths.reports, `${report.id}.md`), report.markdown ?? '');
  }
  if (deps.publish) {
    const { results: _r, diff: _d, gate: _g, ...base } = report;
    await deps.publish.putEvalReport(base);
  }
  return { report, ledgerEntry: settled };
}
