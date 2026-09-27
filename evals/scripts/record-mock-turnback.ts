/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Records the mock-mode airborne recording (task 07) for the web app: the s11 air-turnback scenario run through the
 * REAL runtime with the SCRIPTED provider (`turnbackScript`, no network, £0) and eval-auto approvals, plus its
 * baseline run. Writes `apps/web/src/mocks/fixtures/s11.{scenario,agent.events,baseline.events}.json`.
 *   npx tsx evals/scripts/record-mock-turnback.ts
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createScriptedProvider, turnbackScript } from '@ica/run';
import { getPublicScenario } from '@ica/scenarios';
import { FLIGHT_DECK_FORBIDDEN_TOOLS, type RunEvent } from '@ica/schema';
import { format, resolveConfig } from 'prettier';
import type { EvalCase } from '../src/case';
import { REPO_ROOT, runAgentCase, runBaselineCase } from '../src/harness';

const scenario = getPublicScenario('s11-air-turnback-bird-strike')!;
const c = {
  id: 'mock-s11',
  scenarioId: scenario.id,
  title: 'mock recording',
  tier: [],
  priority: 100,
  policy: {},
  expected: {},
} as unknown as EvalCase;

const agent = await runAgentCase(c, scenario, {
  providerMode: 'scripted',
  scriptedFactory: (clock) => createScriptedProvider(turnbackScript(), { clock, latencyMs: 3000 }),
});
const baseline = await runBaselineCase(c, scenario);

const blocked = agent.events.filter(
  (e) =>
    e.type === 'guardrail.blocked' &&
    (FLIGHT_DECK_FORBIDDEN_TOOLS as readonly string[]).includes(e.payload.tool ?? ''),
);
if (blocked.length) throw new Error('the scripted turnback must not attempt flight-deck tools');
const failed = agent.events.filter((e) => e.type === 'agent.tool_result' && !e.payload.ok);
if (failed.length)
  throw new Error(`tool calls failed: ${failed.map((e) => JSON.stringify(e.payload)).join('\n')}`);

/** The web fixtures use their own run ids (the mock backend re-stamps them per run). */
const restamp = (events: RunEvent[], runId: string, pairedRunId: string) =>
  events.map((e) =>
    e.type === 'run.created'
      ? ({ ...e, runId, payload: { ...e.payload, pairedRunId } } as RunEvent)
      : { ...e, runId },
  );

const outDir = join(REPO_ROOT, 'apps', 'web', 'src', 'mocks', 'fixtures');
async function write(name: string, data: unknown) {
  const path = join(outDir, name);
  const opts = { ...((await resolveConfig(path)) ?? {}), filepath: path };
  writeFileSync(path, await format(JSON.stringify(data), opts));
  console.log(
    `wrote apps/web/src/mocks/fixtures/${name}${Array.isArray(data) ? ` (${data.length} events)` : ''}`,
  );
}
await write('s11.scenario.json', scenario);
await write('s11.agent.events.json', restamp(agent.events, 'run-demo-s11', 'run-demo-s11-baseline'));
await write('s11.baseline.events.json', restamp(baseline.events, 'run-demo-s11-baseline', 'run-demo-s11'));
console.log(`agent run: ${agent.result?.status ?? 'n/a'}, ${agent.events.length} events`);
