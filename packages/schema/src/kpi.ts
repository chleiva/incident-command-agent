/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * KPI types (spec §8). Types only: the formulas are implemented by task 02 (`services/run/world/kpi.ts`) as pure
 * functions. Every KPI carries its formula, inputs and contributing event seqs for the UI's "why this number" drawer.
 */
import { Type, type Static, type TSchema } from '@sinclair/typebox';

export const KpiInputValueSchema = Type.Union([Type.Number(), Type.String(), Type.Boolean(), Type.Null()]);

/** Generic KPI wrapper. */
export const KpiOf = <T extends TSchema>(value: T) =>
  Type.Object({
    value,
    /** Human-readable formula, e.g. "primary min × €/min + reactionary min × factor × €/min". */
    formula: Type.String(),
    inputs: Type.Record(Type.String(), KpiInputValueSchema),
    /** Seqs of the events that moved this value. */
    contributingSeqs: Type.Array(Type.Integer({ minimum: 1 })),
  });

export interface Kpi<T> {
  value: T;
  formula: string;
  inputs: Record<string, number | string | boolean | null>;
  contributingSeqs: number[];
}

export const ComplianceValueSchema = Type.Object({
  art14NoticeIssued: Type.Boolean(),
  /** null = not applicable yet (no delay ≥ 3 h projected). */
  reroutingOfferedWithin3h: Type.Union([Type.Boolean(), Type.Null()]),
  fdpRespected: Type.Boolean(),
  morDraftedWithin72h: Type.Boolean(),
  threeHourThresholdAvoided: Type.Union([Type.Boolean(), Type.Null()]),
});
export type ComplianceValue = Static<typeof ComplianceValueSchema>;

export const SafetyValueSchema = Type.Object({
  /** Must be 0. */
  forbiddenAttempts: Type.Integer({ minimum: 0 }),
  humanDecisionsBeforeDependentActions: Type.Integer({ minimum: 0 }),
  dependentActionsWithoutDecision: Type.Integer({ minimum: 0 }),
});
export type SafetyValue = Static<typeof SafetyValueSchema>;

export const LatencyValueSchema = Type.Object({
  firstEngineeringDecisionMin: Type.Union([Type.Number(), Type.Null()]),
  firstPaxMessageMin: Type.Union([Type.Number(), Type.Null()]),
  swapOrCancelDecisionMin: Type.Union([Type.Number(), Type.Null()]),
});
export type LatencyValue = Static<typeof LatencyValueSchema>;

export const KpiSnapshotSchema = Type.Object({
  simMinute: Type.Number(),
  /** Minutes since the trigger (incident clock). */
  incidentClockMin: Type.Number(),
  /** Minutes left before the projected delay crosses 3 h (can be negative). */
  minutesTo3h: Type.Number(),
  delayCostEur: KpiOf(Type.Number()),
  eu261ExposureEur: KpiOf(Type.Number()),
  cancellationCostEur: KpiOf(Type.Number()),
  totalCostEur: KpiOf(Type.Number()),
  /** 0–100. */
  satisfaction: KpiOf(Type.Number({ minimum: 0, maximum: 100 })),
  compliance: KpiOf(ComplianceValueSchema),
  safety: KpiOf(SafetyValueSchema),
  latency: KpiOf(LatencyValueSchema),
});
export type KpiSnapshot = Static<typeof KpiSnapshotSchema>;

export const KPI_KEYS = [
  'delayCostEur',
  'eu261ExposureEur',
  'cancellationCostEur',
  'totalCostEur',
  'satisfaction',
  'compliance',
  'safety',
  'latency',
] as const;
export type KpiKey = (typeof KPI_KEYS)[number];
