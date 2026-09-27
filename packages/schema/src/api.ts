/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * HTTP + WebSocket API contracts (spec §5 + CLAUDE.md additions). Request bodies have TypeBox schemas so the router
 * (task 04) validates them with Ajv (`compileSchema`); responses are typed.
 */
import { Type, type Static } from '@sinclair/typebox';
import { ProviderModelSchema, RunTotalsSchema, ScreeningResultSchema, type ScreeningResult } from './common';
import {
  ApprovalDecisionKindSchema,
  CONTROL_ACTIONS,
  DemoForbiddenToolSchema,
  type RunEvent,
} from './events';
import { RunModeSchema, RunStatusSchema, literalUnion, type StateSystemName } from './ids';
import type { Scenario } from './scenario';
import type { EvidencePack } from './systems';

const Str = Type.String();
const Opt = Type.Optional;

// ------------------------------------------------------------------------------------------------ domain records
export const RunMetaSchema = Type.Object({
  runId: Str,
  scenarioId: Str,
  scenarioTitle: Str,
  mode: RunModeSchema,
  status: RunStatusSchema,
  pairedRunId: Opt(Str),
  /** ISO wall time. */
  createdAt: Type.String({ format: 'date-time' }),
  simMinute: Type.Number({ minimum: 0 }),
  /** Maintained by `Store.append` only. */
  lastSeq: Type.Integer({ minimum: 0 }),
  totals: RunTotalsSchema,
  speed: Type.Number(),
  /** Additions. */
  llm: Opt(ProviderModelSchema),
  updatedAt: Opt(Type.String({ format: 'date-time' })),
  endedAt: Opt(Type.String({ format: 'date-time' })),
  error: Opt(Str),
});
export type RunMeta = Static<typeof RunMetaSchema>;

export const ScenarioSummarySchema = Type.Object({
  id: Str,
  title: Str,
  station: Str,
  aircraftType: Str,
  triggerType: Str,
  visibility: literalUnion(['public', 'private'] as const),
  twistCount: Type.Integer({ minimum: 0 }),
  inspiredBy: Type.Array(Type.Object({ sourceId: Str, url: Str, note: Str })),
});
export type ScenarioSummary = Static<typeof ScenarioSummarySchema>;

export function summariseScenario(s: Scenario): ScenarioSummary {
  return {
    id: s.id,
    title: s.title,
    station: s.aircraft.station,
    aircraftType: s.aircraft.type,
    triggerType: s.trigger.type,
    visibility: s.visibility,
    twistCount: s.twists.length,
    inspiredBy: s.inspiredBy,
  };
}

export const StationSchema = Type.Object({
  iata: Str,
  name: Str,
  lat: Type.Number(),
  lon: Type.Number(),
  country: Str,
});
export type Station = Static<typeof StationSchema>;

export const BrandPackSchema = Type.Object({
  /** Addition (task 06): the product name shown in the title bar (default "Ground Incident Coordination Agent"). */
  productName: Opt(Str),
  carrierName: Str,
  carrierCode: Str,
  logoSvg: Opt(Str),
  colours: Type.Object({ primary: Str, accent: Str }),
  consultancyName: Opt(Str),
  stations: Type.Array(Str),
  disclaimer: Str,
});
export type BrandPack = Static<typeof BrandPackSchema>;

export const AppConfigSchema = Type.Object({
  brand: BrandPackSchema,
  features: Type.Object({
    webSearch: Type.Boolean(),
    liveWeather: Type.Boolean(),
    narrator: Type.Boolean(),
    sideBySide: Type.Boolean(),
  }),
  stations: Type.Array(StationSchema),
  limits: Type.Object({
    maxRunsPerDay: Type.Integer(),
    runBudgetUsd: Type.Number(),
    horizonMin: Type.Number(),
    speedMin: Type.Number(),
    speedMax: Type.Number(),
  }),
});
export type AppConfig = Static<typeof AppConfigSchema>;

/** `/config.json` served next to the SPA. */
export const WebRuntimeConfigSchema = Type.Object({
  apiUrl: Str,
  wsUrl: Str,
  auth: Type.Union([
    Type.Object({ mode: Type.Literal('none') }),
    Type.Object({
      mode: Type.Literal('cognito'),
      region: Str,
      userPoolId: Str,
      clientId: Str,
      domain: Str,
      redirectUri: Str,
    }),
  ]),
});
export type WebRuntimeConfig = Static<typeof WebRuntimeConfigSchema>;

/**
 * Evaluation report (task 02 fills it in; open for additional fields). `GET /evals/latest`.
 */
export const EvalReportSchema = Type.Object({
  /** Report id; also the `EVAL#{id}` key. */
  id: Str,
  createdAt: Type.String({ format: 'date-time' }),
  tier: Str,
  gitSha: Opt(Str),
  caseCount: Type.Integer({ minimum: 0 }),
  /** Pass rate (0–1) per layer: trajectory, outcome, grounding, judge, robustness, cost. */
  passRateByLayer: Type.Record(Type.String(), Type.Number({ minimum: 0, maximum: 1 })),
  hardAssertionPassRate: Type.Number({ minimum: 0, maximum: 1 }),
  judgeMean: Type.Union([Type.Number(), Type.Null()]),
  spend: Type.Object({ usd: Type.Number({ minimum: 0 }), gbp: Type.Number({ minimum: 0 }) }),
  ledger: Type.Object({
    lifetimeCapGbp: Type.Number(),
    spentGbp: Type.Number(),
    reservedGbp: Type.Number(),
    remainingGbp: Type.Number(),
  }),
  cases: Type.Array(
    Type.Object({
      caseId: Str,
      scenarioId: Str,
      passed: Type.Boolean(),
      skippedReason: Opt(Str),
    }),
  ),
  markdown: Opt(Str),
});
export type EvalReport = Static<typeof EvalReportSchema>;

export const ApiErrorSchema = Type.Object({ error: Str, code: Str });
export type ApiError = Static<typeof ApiErrorSchema>;

// ------------------------------------------------------------------------------------------------ request bodies
export const AuthorScenarioRequestSchema = Type.Object(
  { text: Type.String({ minLength: 1, maxLength: 8000 }) },
  { additionalProperties: false },
);
export type AuthorScenarioRequest = Static<typeof AuthorScenarioRequestSchema>;

export const CreateRunRequestSchema = Type.Object(
  {
    scenarioId: Type.String({ minLength: 1 }),
    mode: RunModeSchema,
    speed: Opt(Type.Number({ minimum: 1, maximum: 30 })),
    pairedRunId: Opt(Str),
  },
  { additionalProperties: false },
);
export type CreateRunRequest = Static<typeof CreateRunRequestSchema>;

export const ApprovalDecisionRequestSchema = Type.Object(
  {
    decision: ApprovalDecisionKindSchema,
    editedArgs: Opt(Type.Record(Type.String(), Type.Unknown())),
    selectedOptionId: Opt(Str),
    reason: Opt(Type.String({ maxLength: 2000 })),
    /** Addition: the approver's role title (default 'Duty Manager'). */
    roleTitle: Opt(Type.String({ minLength: 1, maxLength: 80 })),
  },
  { additionalProperties: false },
);
export type ApprovalDecisionRequest = Static<typeof ApprovalDecisionRequestSchema>;

export const TwistRequestSchema = Type.Union([
  Type.Object({ twistId: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
  Type.Object({ text: Type.String({ minLength: 1, maxLength: 2000 }) }, { additionalProperties: false }),
]);
export type TwistRequest = Static<typeof TwistRequestSchema>;

export const ControlRequestSchema = Type.Object(
  {
    action: literalUnion(CONTROL_ACTIONS),
    speed: Opt(Type.Number({ minimum: 1, maximum: 30 })),
    /** Addition (task 06): the forbidden tool to demonstrate with `demo_forbidden` (default `defer_defect`). */
    tool: Opt(DemoForbiddenToolSchema),
  },
  { additionalProperties: false },
);
export type ControlRequest = Static<typeof ControlRequestSchema>;

// ------------------------------------------------------------------------------------------------ responses
export interface ListScenariosResponse {
  items: ScenarioSummary[];
}
export type GetScenarioResponse = Scenario;
export interface AuthorScenarioResponse {
  scenario?: Scenario;
  errors?: string[];
  screening: ScreeningResult;
}
export interface CreateRunResponse {
  runId: string;
}
export interface ListRunsResponse {
  items: RunMeta[];
}
export type GetRunResponse = RunMeta;
export interface ListEventsResponse {
  events: RunEvent[];
  lastSeq: number;
  hasMore: boolean;
}
export interface ApprovalDecisionResponse {
  accepted: true;
  seq: number;
}
export interface TwistResponse {
  accepted: boolean;
  seq?: number;
  screening?: ScreeningResult;
}
export interface ControlResponse {
  accepted: boolean;
  seq: number;
}
export interface SystemStateResponse {
  system: StateSystemName;
  entities: Record<string, Record<string, Record<string, unknown>>>;
  asOfSeq: number;
}
export interface ExportResponse {
  trace: RunEvent[] | { url: string };
  evidencePack?: EvidencePack;
}
export type GetConfigResponse = AppConfig;
export type GetLatestEvalResponse = EvalReport;

export { ScreeningResultSchema };

// ------------------------------------------------------------------------------------------------ routes
/** Every HTTP route. All require the Cognito JWT (except locally with AUTH_MODE=none). */
export const API_ROUTES = {
  listScenarios: { method: 'GET', path: '/scenarios' },
  getScenario: { method: 'GET', path: '/scenarios/{id}' },
  authorScenario: { method: 'POST', path: '/scenarios/author' },
  createRun: { method: 'POST', path: '/runs' },
  listRuns: { method: 'GET', path: '/runs' },
  getRun: { method: 'GET', path: '/runs/{id}' },
  listEvents: { method: 'GET', path: '/runs/{id}/events' },
  decideApproval: { method: 'POST', path: '/runs/{id}/approvals/{approvalId}' },
  injectTwist: { method: 'POST', path: '/runs/{id}/twists' },
  control: { method: 'POST', path: '/runs/{id}/control' },
  getSystemState: { method: 'GET', path: '/runs/{id}/systems/{name}' },
  exportRun: { method: 'GET', path: '/runs/{id}/export' },
  getConfig: { method: 'GET', path: '/config' },
  getLatestEval: { method: 'GET', path: '/evals/latest' },
} as const;
export type ApiRouteName = keyof typeof API_ROUTES;

/** Query parameters. */
export interface ListEventsQuery {
  after?: number;
  /** ≤ 500. */
  limit?: number;
}
export interface ListRunsQuery {
  limit?: number;
}
export const MAX_EVENTS_PAGE = 500;

// ------------------------------------------------------------------------------------------------ WebSocket
/** Connect with `?token=<JWT>&runId=<id>` (local: `ws://localhost:8787/ws?runId=`). */
export type WsServerMessage = { kind: 'events'; runId: string; events: RunEvent[] } | { kind: 'ping' };
export type WsClientMessage = { action: 'ping' };
