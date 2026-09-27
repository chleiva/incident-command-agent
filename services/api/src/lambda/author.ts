/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * `author` Lambda entry (1024 MB, 60 s): synchronous `{text}` → `runAuthor` → AuthorResult. Invoked by the `api`
 * Lambda for `POST /scenarios/author`; the api validates and saves the scenario.
 */
import type { AuthorResult } from '@ica/schema';
import { knowledgeS3PathFromEnv, loadKnowledgeIndex, runAuthor } from '@ica/run';
import { createLogger, errorFields } from '../util/log';
import { createAwsRunDeps } from './aws-deps';

const log = createLogger({ fn: 'author' });
const deps = createAwsRunDeps(() => loadKnowledgeIndex({ source: 's3', path: knowledgeS3PathFromEnv() }));

export async function handler(event: { text?: unknown }): Promise<AuthorResult> {
  if (typeof event?.text !== 'string' || !event.text.trim()) throw new Error('text is required');
  const started = Date.now();
  try {
    const result = await runAuthor(event.text, await deps());
    log.info('author completed', {
      latencyMs: Date.now() - started,
      verdict: result.screening?.verdict,
      scenarioId: result.scenario?.id,
      errors: result.errors?.length ?? 0,
    });
    return result;
  } catch (err) {
    log.error('author failed', errorFields(err));
    throw err;
  }
}
