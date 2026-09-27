/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** Shared test fixtures for @ica/api (not exported from the package). */
import { type ApprovalRecord, type AuthorResult, type Scenario, type ScreeningResult } from '@ica/schema';
import scenarioFixture from '@ica/schema/fixtures/scenario.minimal.json' with { type: 'json' };
import { MemoryEventBus, MemoryStore, MemoryTraceStore } from '@ica/store';
import { DEFAULT_BRAND, FALLBACK_STATIONS } from './config/app-config';
import { settingsFromEnv } from './config/settings';
import type { ApiDeps } from './http/deps';
import { createApiHandler } from './http/routes';
import type { HttpEvent, HttpResult, JwtClaims } from './http/types';

export const SCENARIO = scenarioFixture as unknown as Scenario;

export const CLAIMS: JwtClaims = { sub: 'user-sub-1', email: 'duty.manager@example.com', token_use: 'id' };

export function req(
  method: string,
  path: string,
  opts: { body?: unknown; claims?: JwtClaims | null; query?: Record<string, string>; origin?: string } = {},
): HttpEvent {
  const claims = opts.claims === undefined ? CLAIMS : opts.claims;
  return {
    version: '2.0',
    rawPath: path,
    rawQueryString: new URLSearchParams(opts.query ?? {}).toString(),
    queryStringParameters: opts.query,
    headers: opts.origin ? { origin: opts.origin } : {},
    body:
      opts.body === undefined
        ? undefined
        : typeof opts.body === 'string'
          ? opts.body
          : JSON.stringify(opts.body),
    requestContext: {
      requestId: 'req-1',
      http: { method },
      ...(claims ? { authorizer: { jwt: { claims } } } : {}),
    },
  };
}

export function json<T = any>(r: HttpResult): T {
  return JSON.parse(r.body || 'null') as T;
}

export function makeDeps(overrides: Partial<ApiDeps> & { env?: Record<string, string> } = {}) {
  const bus = new MemoryEventBus();
  const store = new MemoryStore({ bus });
  const traces = new MemoryTraceStore();
  const launched: string[] = [];
  const screenCalls: string[] = [];
  let authorResult: AuthorResult = { screening: { verdict: 'clean', findings: [] } };
  let screenResult: ScreeningResult = { verdict: 'clean', findings: [] };
  let t = new Date('2026-06-01T09:00:00.000Z');
  let n = 0;
  const deps: ApiDeps = {
    store,
    traces,
    launcher: { launch: async (runId) => void launched.push(runId) },
    author: { author: async () => authorResult },
    screen: async (text) => {
      screenCalls.push(text);
      return screenResult;
    },
    publicScenarios: [SCENARIO],
    settings: settingsFromEnv({
      AUTH_MODE: 'cognito',
      CORS_ORIGINS: 'https://d111.cloudfront.net',
      MAX_RUNS_PER_DAY: '3',
      LLM_PROVIDER: 'scripted',
      LLM_MODEL: 'test-model',
      ...overrides.env,
    }),
    appConfigSource: async () => ({ brand: DEFAULT_BRAND, stations: FALLBACK_STATIONS }),
    now: () => t,
    newRunId: () => `run-test-${++n}`,
    ...overrides,
  };
  return {
    deps,
    store,
    bus,
    traces,
    launched,
    screenCalls,
    handler: createApiHandler(deps),
    setAuthorResult: (r: AuthorResult) => (authorResult = r),
    setScreenResult: (r: ScreeningResult) => (screenResult = r),
    setNow: (d: Date) => (t = d),
  };
}

export function pendingApproval(runId: string, over: Partial<ApprovalRecord> = {}): ApprovalRecord {
  return {
    runId,
    approvalId: 'apr-1',
    status: 'pending',
    agentRunId: 'ar-pax-1',
    role: 'passenger',
    toolCallId: 'tc-1',
    tool: 'send_passenger_message',
    args: { messageId: 'msg-1' },
    summary: 'Send the first update',
    proposalSeq: 1,
    createdAtMinute: 0,
    ...over,
  };
}
