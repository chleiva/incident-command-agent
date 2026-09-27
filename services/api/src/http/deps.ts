/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** Everything the router needs, injected (Lambda: DynamoDB/S3/Lambda invoke; local: memory + in-process). */
import type { AppConfig, AuthoringRequest, Scenario, ScreeningResult, Store, TraceStore } from '@ica/schema';
import type { ApiSettings } from '../config/settings';
import type { Logger } from '../util/log';

/** Starts a run asynchronously (Lambda: `InvocationType: 'Event'`; local: fire-and-forget in-process). */
export interface RunLauncher {
  /** `authoring`: the run patches its (template) scenario from the screened free text before the world starts. */
  launch(runId: string, opts?: { authoring?: AuthoringRequest }): Promise<void>;
}

/**
 * Starts the Scenario Author for a Training draft, asynchronously (Lambda: `InvocationType: 'Event'` of the author
 * Lambda; local: in-process). The author writes the result to the draft (`Store.putAuthorDraft`).
 */
export interface AuthorInvoker {
  start(draftId: string, text: string): Promise<void>;
}

export interface ApiDeps {
  store: Store;
  traces: TraceStore;
  launcher: RunLauncher;
  author: AuthorInvoker;
  /** Input screening (spec §11 layer 3), `screenInput` from @ica/run. */
  screen(text: string): Promise<ScreeningResult>;
  /**
   * Fast input screening for `POST /runs` and `POST /scenarios/author` (regex heuristics only, never an LLM:
   * `screenInputFast` from @ica/run). Defaults to `screen`.
   */
  screenFast?(text: string): ScreeningResult | Promise<ScreeningResult>;
  /** Shipped scenarios (`publicScenarios` from @ica/scenarios). */
  publicScenarios: Scenario[];
  settings: ApiSettings;
  /** Brand pack + stations inputs; the router adds features/limits and caches the result. */
  appConfigSource(): Promise<Pick<AppConfig, 'brand'> & { stations: AppConfig['stations'] }>;
  /**
   * Display name for a Cognito username when the JWT has no readable claim (Lambda: `AdminGetUser`, cached per
   * container; see user-names.ts). Without it, the username is recorded.
   */
  resolveUserName?(username: string): Promise<string | null>;
  /**
   * Presigned GET URL for a trace key (Lambda only; default lifetime 15 min, audit traces pass 5 min). Without it,
   * exports and audit traces are always inline.
   */
  presign?(key: string, opts?: { expiresIn?: number }): Promise<string>;
  now?(): Date;
  newRunId?(): string;
  newDraftId?(): string;
  log?: Logger;
  /** Exports above this size are offloaded to the TraceStore and returned as a URL (default 5 MB). */
  exportInlineMaxBytes?: number;
  /** Audit LLM traces above this size are returned as a presigned URL (default 5 MB). */
  auditInlineMaxBytes?: number;
  /** AppConfig cache lifetime in ms (default 60 s). */
  configTtlMs?: number;
}

/** Thrown by the local runner/author stubs until task 02 lands; mapped to 501. */
export function isNotImplemented(err: unknown): boolean {
  return err instanceof Error && /not implemented/i.test(err.message);
}
