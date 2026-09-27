/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Records the replay fixture for `fx-runtime-smoke` with the SCRIPTED provider (no network, £0): the runtime-only demo
 * conversation for the agents and a fixed, clearly marked synthetic verdict for the judge. This proves the replay CI
 * path before real recordings exist; the first real recordings come from the planned live smoke run.
 */
import { createScriptedProvider, demoScript } from '@ica/run';
import { loadCases } from '../src/case';
import { PATHS } from '../src/harness';
import { DIMENSIONS } from '../src/judge';
import { runTier } from '../src/run-tier';

const verdict = Object.fromEntries(
  DIMENSIONS.map((d) => [
    d,
    d === 'occurrenceReport' || d === 'passengerMessage' || d === 'faithfulness'
      ? { score: null, why: 'synthetic fixture: not applicable to the runtime-only script' }
      : { score: 4, why: 'synthetic fixture verdict (scripted judge), not a real model judgement' },
  ]),
);

const cases = loadCases(PATHS.cases).filter((c) => c.id === 'fx-runtime-smoke');
const { report } = await runTier(
  { tier: 'replay', live: false, yes: false, caseIds: ['fx-runtime-smoke'] },
  {
    cases,
    log: console.log,
    confirm: async () => false,
    writeReport: false,
    scripted: {
      agent: (clock) => createScriptedProvider(demoScript(), { clock, latencyMs: 4000 }),
      judge: createScriptedProvider(() => ({
        text: JSON.stringify(verdict),
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      })),
    },
  },
);
const r = report.results[0];
console.log(
  `recorded fx-runtime-smoke: passed=${r.passed}, judge=${r.judge?.mean}, assertions failed: ${
    r.assertions
      .filter((a) => !a.passed)
      .map((a) => a.id)
      .join(', ') || 'none'
  }`,
);
