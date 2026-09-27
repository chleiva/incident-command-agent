/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * `author` Lambda entry (1024 MB, 5 min): invoked **asynchronously** by the `api` Lambda for `POST /scenarios/author`
 * with `{draftId, text}` → `runAuthor` → validated scenario stored as private, draft marked `ready` (or `failed`).
 * No longer behind API Gateway, so the Scenario Author is not bound by the 29 s request limit.
 */
import type { AuthorDraft } from '@ica/schema';
import { knowledgeS3PathFromEnv, loadKnowledgeIndex, runAuthor } from '@ica/run';
import { publicScenarios } from '@ica/scenarios';
import { completeAuthorDraft } from '../http/drafts';
import { createLogger, errorFields } from '../util/log';
import { awsCore, createAwsRunDeps } from './aws-deps';

const log = createLogger({ fn: 'author' });
const deps = createAwsRunDeps(() => loadKnowledgeIndex({ source: 's3', path: knowledgeS3PathFromEnv() }));

export async function handler(event: { draftId?: unknown; text?: unknown }): Promise<AuthorDraft> {
  if (typeof event?.draftId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(event.draftId))
    throw new Error('draftId is required');
  if (typeof event?.text !== 'string' || !event.text.trim()) throw new Error('text is required');
  const { store } = awsCore();
  const started = Date.now();
  const publicIds = publicScenarios.map((s) => s.id);
  try {
    const result = await runAuthor(event.text, await deps());
    const draft = await completeAuthorDraft(store, event.draftId, { result }, { publicIds });
    log.info('author completed', {
      draftId: event.draftId,
      latencyMs: Date.now() - started,
      verdict: result.screening?.verdict,
      status: draft.status,
      scenarioId: draft.scenario?.id,
      errors: draft.errors?.length ?? 0,
    });
    return draft;
  } catch (err) {
    log.error('author failed', { draftId: event.draftId, ...errorFields(err) });
    // Never retried (async invoke retries are off): the draft reports the failure to the polling UI.
    return completeAuthorDraft(store, event.draftId, { error: err }, { publicIds });
  }
}
