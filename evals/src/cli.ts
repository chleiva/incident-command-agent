/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * `npm run eval -- [--tier replay|baseline|smoke|core|full] [--live] [--cases a,b] [--yes] [--publish] [--no-gate]`
 * `npm run eval:budget`
 *
 * Default = `--tier replay` (free). Any spend needs `--tier smoke|core|full --live` plus confirmation, and draws on the
 * LIFETIME £10 budget in evals/ledger.json. Never run a live eval without the owner's explicit go-ahead.
 */
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { EnvSecretStore } from '@ica/store';
import { createProvider } from '@ica/run';
import { readLedger, summarise, BudgetRefusal } from './budget';
import { loadCases } from './case';
import { PATHS } from './harness';
import { runTier, type Tier } from './run-tier';

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false; // non-interactive: only --yes can confirm
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${question} Type "spend" to confirm: `);
  rl.close();
  return answer.trim() === 'spend';
}

function printBudget(): void {
  const ledger = readLedger(PATHS.ledger);
  const s = summarise(ledger);
  console.log(`Lifetime live-eval budget: £${s.capGbp} (hard cap, can only be lowered)`);
  console.log(
    `  spent (settled): £${s.spentGbp}\n  reserved (open): £${s.reservedGbp}${s.openReservations.length ? ` [${s.openReservations.join(', ')}]` : ''}\n  remaining:       £${s.remainingGbp}`,
  );
  for (const e of ledger.entries) {
    console.log(
      `  ${e.date.slice(0, 19)} ${e.status.padEnd(8)} ${e.id} tier=${e.tier} cases=${e.caseIds.length} reserved £${e.reservedGbp.toFixed(3)}${e.actualGbp !== null ? ` actual £${e.actualGbp.toFixed(3)}` : ''}`,
    );
  }
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      tier: { type: 'string', default: 'replay' },
      live: { type: 'boolean', default: false },
      cases: { type: 'string' },
      yes: { type: 'boolean', default: false },
      publish: { type: 'boolean', default: false },
      'no-gate': { type: 'boolean', default: false },
      model: { type: 'string' },
      'judge-model': { type: 'string' },
    },
  });
  if (positionals[0] === 'budget') return printBudget();
  const tier = values.tier as Tier;
  if (!['replay', 'baseline', 'smoke', 'core', 'full'].includes(tier))
    throw new Error(`unknown tier ${tier}`);
  const cases = loadCases(PATHS.cases);
  let publish;
  if (values.publish) {
    if (!process.env.TABLE_NAME) console.warn('--publish: TABLE_NAME not set; skipping publish');
    else {
      const { DynamoStore } = await import('@ica/store');
      publish = new DynamoStore({ tableName: process.env.TABLE_NAME, region: process.env.AWS_REGION });
    }
  }
  const { report } = await runTier(
    {
      tier,
      live: values.live!,
      yes: values.yes!,
      caseIds: values.cases
        ?.split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      agentModel: values.model,
      judgeModel: values['judge-model'],
    },
    {
      cases,
      log: (l) => console.log(l),
      confirm,
      publish,
      liveProviders: async () => {
        const secrets = new EnvSecretStore();
        const anthropic = await createProvider('anthropic', { secrets });
        return { agent: { anthropic }, judge: anthropic };
      },
    },
  );
  console.log(report.markdown);
  console.log(`report → evals/reports/${report.id}.json`);
  if (report.live)
    console.log(
      '\nREMINDER: commit evals/ledger.json and evals/fixtures/ now (the ledger is the lifetime budget record).',
    );
  if (!report.gate.passed && !values['no-gate']) {
    console.error(`eval gate FAILED: ${report.gate.reasons.join('; ')}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  if (err instanceof BudgetRefusal) console.error(`\n${err.message}`);
  else console.error(err);
  process.exit(2);
});
