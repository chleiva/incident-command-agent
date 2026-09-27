/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * @ica/run entry points (task 02). Task 04 imports `executeRun`, `runAuthor`, `screenInput` and
 * `loadKnowledgeIndex` from here; the evals import the runtime pieces.
 */
import { EnvSecretStore } from '@ica/store';
import type { AuthorResult, ExecuteRunInput, RunDeps, ScreeningResult } from '@ica/schema';
import { createLlmClassifier } from './guardrails/classifier';
import { screenText, type ScreenInputOptions } from './guardrails/screen-input';
import { createProvider } from './llm/router';
import { defaultRegistry } from './runtime/registry';
import {
  executeRunWith,
  runAuthorWith,
  toolNamesFor,
  type ExecuteRunOptions,
  type RunAuthorOptions,
  type RunResult,
} from './runtime/run';

export { domainTools } from './tools/index';
export { seedAll, systems } from './systems/index';
export { roles } from './agents/index';
export { knowledgeS3PathFromEnv, loadKnowledgeIndex, type LoadKnowledgeOptions } from './knowledge/index';

export * from './runtime/index';
export * from './llm/index';
export * from './guardrails/index';
export { createLlmClassifier } from './guardrails/classifier';
export * from './world/clock';
export * from './world/engine';
export * from './world/kpi';
export * from './world/twists';
export * from './baseline/run';

/** Run a whole scenario (world engine + agents, or baseline replay). Resolves when the run ends. */
export async function executeRun(input: ExecuteRunInput, opts: ExecuteRunOptions = {}): Promise<RunResult> {
  return executeRunWith(input, opts);
}

/** Free text → Scenario Author agent → validated scenario. */
export async function runAuthor(
  text: string,
  deps: RunDeps,
  opts: RunAuthorOptions = {},
): Promise<AuthorResult> {
  return runAuthorWith(text, deps, opts);
}

let classifier: ScreenInputOptions['classifier'] | undefined;

/**
 * Input screening (spec §11 layer 3) for scenario text, author input and free-text twists: regex heuristics, plus a
 * cached Haiku classifier when `SCREEN_WITH_LLM=true` (and an Anthropic key is available).
 */
export async function screenInput(text: string, opts: ScreenInputOptions = {}): Promise<ScreeningResult> {
  let c = opts.classifier;
  if (!c && process.env.SCREEN_WITH_LLM === 'true') {
    if (!classifier) {
      try {
        classifier = createLlmClassifier(
          await createProvider('anthropic', { secrets: new EnvSecretStore() }),
        );
      } catch (err) {
        console.warn(
          JSON.stringify({
            msg: 'SCREEN_WITH_LLM: classifier unavailable',
            err: String((err as Error).message),
          }),
        );
      }
    }
    c = classifier;
  }
  return screenText(text, { toolNames: toolNamesFor(defaultRegistry()), ...opts, classifier: c });
}
