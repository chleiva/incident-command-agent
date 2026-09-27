/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** Everything the router needs, injected (Lambda: DynamoDB/S3/Lambda invoke; local: memory + in-process). */
import type { AppConfig, AuthorResult, Scenario, ScreeningResult, Store, TraceStore } from '@ica/schema';
import type { ApiSettings } from '../config/settings';
import type { Logger } from '../util/log';

/** Starts a run asynchronously (Lambda: `InvocationType: 'Event'`; local: fire-and-forget in-process). */
export interface RunLauncher {
  launch(runId: string): Promise<void>;
}

/** Runs the Scenario Author synchronously (Lambda: RequestResponse invoke of the author Lambda). */
export interface AuthorInvoker {
  author(text: string): Promise<AuthorResult>;
}

export interface ApiDeps {
  store: Store;
  traces: TraceStore;
  launcher: RunLauncher;
  author: AuthorInvoker;
  /** Input screening (spec §11 layer 3), `screenInput` from @ica/run. */
  screen(text: string): Promise<ScreeningResult>;
  /** Shipped scenarios (`publicScenarios` from @ica/scenarios). */
  publicScenarios: Scenario[];
  settings: ApiSettings;
  /** Brand pack + stations inputs; the router adds features/limits and caches the result. */
  appConfigSource(): Promise<Pick<AppConfig, 'brand'> & { stations: AppConfig['stations'] }>;
  /** Presigned GET URL for a trace key (Lambda only). Without it, exports are always inline. */
  presign?(key: string): Promise<string>;
  now?(): Date;
  newRunId?(): string;
  log?: Logger;
  /** Exports above this size are offloaded to the TraceStore and returned as a URL (default 5 MB). */
  exportInlineMaxBytes?: number;
  /** AppConfig cache lifetime in ms (default 60 s). */
  configTtlMs?: number;
}

/** Thrown by the local runner/author stubs until task 02 lands; mapped to 501. */
export function isNotImplemented(err: unknown): boolean {
  return err instanceof Error && /not implemented/i.test(err.message);
}
