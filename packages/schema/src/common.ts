/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** Supporting types shared by events, runtime and API. */
import { Type, type Static } from '@sinclair/typebox';
import { ProviderIdSchema, literalUnion } from './ids';

/** A knowledge citation. `quote` is verbatim from the chunk (≤ 300 chars). */
export const CitationSchema = Type.Object({
  sourceId: Type.String({ minLength: 1 }),
  url: Type.String(),
  title: Type.String(),
  quote: Type.String({ maxLength: 300 }),
  chunkId: Type.String(),
});
export type Citation = Static<typeof CitationSchema>;

/**
 * Addition (task 06): exactly what approving a recommendation or proposal authorises, and what it does not.
 * The runtime supplies it from the tool definition (`ToolDefinition.approvalScope`) when the agent does not.
 */
export const ApprovalScopeSchema = Type.Object({
  authorises: Type.String({ minLength: 1 }),
  doesNotAuthorise: Type.Array(Type.String()),
});
export type ApprovalScope = Static<typeof ApprovalScopeSchema>;

/**
 * Addition (task 06): a fact a proposal depends on (e.g. `engineerEtaMinute`). `source` points at where the value
 * was read, as `system/entity/id#field` when it comes from mock state (the runtime watches those for changes).
 */
export const AssumptionSchema = Type.Object({
  key: Type.String({ minLength: 1 }),
  value: Type.Union([Type.Number(), Type.String(), Type.Boolean(), Type.Null()]),
  source: Type.String(),
});
export type Assumption = Static<typeof AssumptionSchema>;

/**
 * Addition (task 06): provenance and scope shown on every recommendation or decision card: sources (citations),
 * timestamps (the data as-of sim minute; the created minute is the event's), unresolved checks and approval scope.
 * All optional; the runtime fills `dataAsOfMinute` and safe defaults.
 */
export const ProvenanceFields = {
  unresolvedChecks: Type.Optional(Type.Array(Type.String({ maxLength: 300 }), { maxItems: 12 })),
  approvalScope: Type.Optional(ApprovalScopeSchema),
  citations: Type.Optional(Type.Array(CitationSchema)),
  dataAsOfMinute: Type.Optional(Type.Number()),
};
export interface Provenance {
  unresolvedChecks?: string[];
  approvalScope?: ApprovalScope;
  citations?: Citation[];
  dataAsOfMinute?: number;
}

/** One alternative in an options decision (drives the OptionsMatrix UI). */
export const DecisionOptionSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  label: Type.String({ minLength: 1 }),
  metrics: Type.Object({
    timeToDepartureMin: Type.Number(),
    costEur: Type.Number(),
    /** 0–100, higher = worse for customers. */
    customerImpact: Type.Number({ minimum: 0, maximum: 100 }),
    compliant: Type.Boolean(),
    constraints: Type.Array(Type.String()),
  }),
  recommended: Type.Boolean(),
  ...ProvenanceFields,
});
export type DecisionOption = Static<typeof DecisionOptionSchema>;

/** Addition (task 06): one agent recommendation with its provenance (aligned with `AgentReport.recommendations`). */
export const RecommendationDetailSchema = Type.Object({
  text: Type.String(),
  ...ProvenanceFields,
});
export type RecommendationDetail = Static<typeof RecommendationDetailSchema>;

/** The label every model interpretation of a defect carries, verbatim (task 06 §1.2). */
export const PROVISIONAL_READING_LABEL = 'Provisional reading — unconfirmed';

/**
 * Addition (task 06): a model's interpretation of a defect. Never a status: it is always unconfirmed until
 * certifying staff decide (recorded with `record_engineering_decision`).
 */
export const ProvisionalReadingSchema = Type.Object(
  {
    text: Type.String({ minLength: 1, maxLength: 800 }),
    confidence: Type.Optional(
      Type.Union([Type.Literal('low'), Type.Literal('medium'), Type.Literal('high')]),
    ),
    unconfirmed: Type.Literal(true),
  },
  { additionalProperties: false },
);
export type ProvisionalReading = Static<typeof ProvisionalReadingSchema>;

/** The structured report every agent returns via its `report` tool. Roles may extend it (reportSchema). */
export const AgentReportSchema = Type.Object({
  summary: Type.String(),
  actionsTaken: Type.Array(Type.String()),
  openIssues: Type.Array(Type.String()),
  recommendations: Type.Array(Type.String()),
  citations: Type.Array(CitationSchema),
  /** Addition (task 06): provenance per recommendation (sources, as-of time, unresolved checks, scope). */
  recommendationDetails: Type.Optional(Type.Array(RecommendationDetailSchema, { maxItems: 12 })),
  /** Addition (task 06): the maintenance agent's interpretation of the defect, always unconfirmed. */
  provisionalReading: Type.Optional(ProvisionalReadingSchema),
});
export type AgentReport = Static<typeof AgentReportSchema>;

export const RunTotalsSchema = Type.Object({
  inputTokens: Type.Integer({ minimum: 0 }),
  outputTokens: Type.Integer({ minimum: 0 }),
  costUsd: Type.Number({ minimum: 0 }),
  toolCalls: Type.Integer({ minimum: 0 }),
  iterations: Type.Integer({ minimum: 0 }),
  wallMs: Type.Number({ minimum: 0 }),
});
export type RunTotals = Static<typeof RunTotalsSchema>;

export const ZERO_TOTALS: RunTotals = {
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  toolCalls: 0,
  iterations: 0,
  wallMs: 0,
};

/** Token usage attached to any event that consumed tokens. */
export const UsageSchema = Type.Object({
  inputTokens: Type.Integer({ minimum: 0 }),
  outputTokens: Type.Integer({ minimum: 0 }),
  cacheReadTokens: Type.Integer({ minimum: 0 }),
  cacheWriteTokens: Type.Integer({ minimum: 0 }),
  costUsd: Type.Number({ minimum: 0 }),
  model: Type.String(),
  provider: Type.String(),
});
export type Usage = Static<typeof UsageSchema>;

/**
 * Hard limits for a run (spec §6). Cost limits (`maxInputTokensPerRun`, `budgetUsd`) use 0 = no limit: the product
 * never stops a run on spend; only the eval harness sets them (owner decision, CLAUDE.md).
 */
export const RunLimitsSchema = Type.Object({
  maxIterationsPerAgent: Type.Integer({ minimum: 1 }),
  maxToolCallsPerRun: Type.Integer({ minimum: 1 }),
  maxInputTokensPerRun: Type.Integer({ minimum: 0 }),
  wallClockMs: Type.Integer({ minimum: 1 }),
  budgetUsd: Type.Number({ minimum: 0 }),
  horizonMin: Type.Number({ minimum: 1 }),
});
export type RunLimits = Static<typeof RunLimitsSchema>;

export const DEFAULT_RUN_LIMITS: RunLimits = {
  maxIterationsPerAgent: 25,
  maxToolCallsPerRun: 60,
  maxInputTokensPerRun: 0,
  wallClockMs: 8 * 60_000,
  budgetUsd: 0,
  horizonMin: 180,
};

/** Tighter limits used by the eval harness (task 02 §8). */
export const EVAL_RUN_LIMITS: RunLimits = {
  maxIterationsPerAgent: 12,
  maxToolCallsPerRun: 40,
  maxInputTokensPerRun: 80_000,
  wallClockMs: 8 * 60_000,
  budgetUsd: 2.0,
  horizonMin: 60,
};

export const ProviderModelSchema = Type.Object({ provider: ProviderIdSchema, model: Type.String() });
export type ProviderModel = Static<typeof ProviderModelSchema>;

/** Result of input screening (spec §11 layer 3). */
export const ScreeningResultSchema = Type.Object({
  verdict: literalUnion(['clean', 'neutralised', 'rejected'] as const),
  findings: Type.Array(Type.Object({ pattern: Type.String(), excerpt: Type.String() })),
  /** Addition: the neutralised (quoted + labelled) text when verdict = 'neutralised'. */
  neutralisedText: Type.Optional(Type.String()),
});
export type ScreeningResult = Static<typeof ScreeningResultSchema>;
