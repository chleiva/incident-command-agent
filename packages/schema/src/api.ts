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
  /**
   * Addition (async authoring): the scenario is still being prepared from free text (flight-context runs). The run
   * that authors clears it on itself and on its paired run once the final scenario is stored; a paired run waits
   * for it before loading the scenario, so both runs use the identical scenario.
   */
  preparing: Opt(Type.Boolean()),
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
  /** Addition (task 06): the product name shown in the title bar (default "Incident Coordination Agent"). */
  productName: Opt(Str),
  carrierName: Str,
  carrierCode: Str,
  logoSvg: Opt(Str),
  colours: Type.Object({ primary: Str, accent: Str }),
  consultancyName: Opt(Str),
  stations: Type.Array(Str),
  disclaimer: Str,
  /** Addition (task 08, owner request): the About dialog's credit and repository link. */
  about: Opt(Type.Object({ author: Str, authorUrl: Str, repoUrl: Opt(Str) })),
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

/**
 * Addition (task 07): a flight from the live network. The server regenerates the day schedule from `seed` and
 * `date`, finds `flightId`, and rebuilds the scenario itself (the client never sends a scenario).
 */
export const FlightContextSchema = Type.Object(
  {
    seed: Type.String({ pattern: '^[a-z0-9-]{1,32}$' }),
    date: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
    flightId: Type.String({ pattern: '^ACX[1-9][0-9]{2}$' }),
    /** Network time of the report (ISO); decides the flight's phase. Default: now. */
    at: Opt(Type.String({ format: 'date-time' })),
  },
  { additionalProperties: false },
);
export type FlightContext = Static<typeof FlightContextSchema>;

export const CreateRunRequestSchema = Type.Object(
  {
    /** A shipped or stored scenario. Required unless `flightContext` is given (exactly one of the two). */
    scenarioId: Opt(Type.String({ minLength: 1 })),
    mode: RunModeSchema,
    speed: Opt(Type.Number({ minimum: 1, maximum: 30 })),
    pairedRunId: Opt(Str),
    /** Addition (task 07): report an incident on a live-network flight. */
    flightContext: Opt(FlightContextSchema),
    /** Addition (task 07): an incident type id from `@ica/network/templates`, or 'other' (free text only). */
    incidentType: Opt(Type.String({ pattern: '^[a-z_]{2,48}$' })),
    /** Addition (task 07): optional free text; screened, then the Scenario Author adds the detail (one LLM call). */
    text: Opt(Type.String({ minLength: 1, maxLength: 4000 })),
    /**
     * Addition (async authoring, flight context only): also create the paired baseline run on the server. Both runs
     * use the identical (authored) scenario; the baseline starts after authoring completes.
     */
    withBaseline: Opt(Type.Boolean()),
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
    /**
     * Addition: `simulation-auto` = the viewer's countdown ran out (simulation). Only with `decision: 'approve'`;
     * recorded as `decidedBy: {kind:'policy', policy:'simulation-auto'}`, never as the person.
     */
    policy: Opt(Type.Literal('simulation-auto')),
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
/**
 * `POST /scenarios/author` → **202** (async authoring): `{draftId, status: 'pending', screening}`; poll
 * `GET /scenarios/drafts/{draftId}` (`AuthorDraft`) for the result. `scenario`/`errors` are only set on a draft.
 */
export interface AuthorScenarioResponse {
  scenario?: Scenario;
  errors?: string[];
  screening: ScreeningResult;
  /** Addition (async authoring). */
  draftId?: string;
  /** Addition (async authoring). */
  status?: AuthorDraftStatus;
}

/** Addition (async authoring). */
export const AUTHOR_DRAFT_STATUSES = ['pending', 'ready', 'failed'] as const;
export type AuthorDraftStatus = (typeof AUTHOR_DRAFT_STATUSES)[number];

/** Addition (async authoring): a Training "write a scenario" request, written by the API, completed by the author Lambda. */
export interface AuthorDraft {
  draftId: string;
  status: AuthorDraftStatus;
  createdAt: string;
  updatedAt?: string;
  screening: ScreeningResult;
  /** Set when `ready`: the validated scenario (already stored as a private scenario). */
  scenario?: Scenario;
  /** Validation errors (`ready` without a scenario is never written: that is `failed`), or the failure reason. */
  errors?: string[];
}
export type GetAuthorDraftResponse = AuthorDraft;
/** A `pending` draft older than this is reported as `failed` (the author Lambda died or timed out). */
export const AUTHOR_DRAFT_STALE_MS = 6 * 60_000;
export interface CreateRunResponse {
  runId: string;
  /** Addition (task 07): the scenario the run uses (a flight-context run creates a private scenario; start the paired
   * baseline with it). */
  scenarioId?: string;
  /** Addition (task 07): screening of the free text, when any. */
  screening?: ScreeningResult;
  /** Addition (task 07): true when the Scenario Author was unavailable or failed and the template scenario was used.
   * (Async authoring: no longer set by `POST /runs`; the outcome is the run's `scenario.authoring` event.) */
  authorFallback?: boolean;
  /** Addition (async authoring): the server-created baseline run (`withBaseline`). */
  pairedRunId?: string;
  /** Addition (async authoring): the scenario is being prepared from the free text in the Run Lambda. */
  preparing?: boolean;
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
  /** Addition (async authoring). */
  getAuthorDraft: { method: 'GET', path: '/scenarios/drafts/{id}' },
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
  /** Addition (audit logs): every LLM call (metadata + `traceKey`) and tool call of a run, chronological. */
  getRunAudit: { method: 'GET', path: '/runs/{id}/audit' },
  /** Addition (audit logs): one stored LLM trace (`?key=traces/{runId}/…json`), or a presigned URL when large. */
  getRunAuditLlm: { method: 'GET', path: '/runs/{id}/audit/llm' },
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
