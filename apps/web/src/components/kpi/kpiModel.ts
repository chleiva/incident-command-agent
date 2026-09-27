/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** The six KPI tiles: value, thresholds (colour only when crossed), ghost delta and "why this number". */
import type { Kpi, KpiSnapshot, RunProjection } from '@ica/schema/browser';
import type { Tone } from '../ui/primitives';
import {
  formatClockDuration,
  formatDuration,
  formatEur,
  formatEurCompact,
  formatInt,
  signed,
} from '../../lib/format';

export const KPI_TILES = ['clock', 'countdown', 'cost', 'satisfaction', 'compliance', 'safety'] as const;
export type KpiTileKey = (typeof KPI_TILES)[number];

/**
 * A check-status line (compliance and safety render as ✓ / ✗ / ⚠ / pending lists, not numeric scores). `warning`
 * (⚠) is a gate that held only because software decided it (auto-approved in the simulation, or a policy): it is
 * never shown as met.
 */
export interface CheckItem {
  key: string;
  label: string;
  status: 'pass' | 'fail' | 'warning' | 'pending';
  note?: string;
  /** Warning: the short text shown in place of the label (the label stays in the tooltip and drawer). */
  short?: string;
}

/** The safety gate's warning text when any gated action was decided by software, not a person. */
export const AUTO_APPROVED_NOT_HUMAN = 'Auto-approved — not a human decision';

/** Extra context for the safety gate that the snapshot may not carry (derived from the run's approvals). */
export interface SafetyContext {
  /** Approval-gated actions approved by simulation/policy (not a person), derived from `approval.decision`. */
  autoApproved?: number;
}

/**
 * Approval-gated actions that went ahead on a software decision (simulation auto-approve, eval or baseline policy):
 * approved or edited approvals whose `decidedBy.kind` is not `human`.
 */
export function autoDecidedApprovals(p: Pick<RunProjection, 'approvals'>): number {
  return Object.values(p.approvals).filter(
    (a) => a.decision && a.decision.decision !== 'reject' && a.decision.decidedBy.kind !== 'human',
  ).length;
}

/**
 * The auto-approved count: the backend's `safety.value.autoApprovedActions` (additive field) when present, else the
 * count derived from the projection.
 */
export function autoApprovedCount(k: KpiSnapshot, ctx?: SafetyContext): number {
  const v = k.safety.value as unknown as Record<string, unknown>;
  const fromBackend = [
    v.autoApprovedActions,
    v.autoApprovedDecisions,
    k.safety.inputs.autoApprovedActions,
  ].find((x): x is number => typeof x === 'number' && Number.isFinite(x));
  return fromBackend ?? ctx?.autoApproved ?? 0;
}

export interface TileModel {
  key: KpiTileKey;
  label: string;
  /** Numeric value for animation and sparklines. */
  value: number;
  display: string;
  sub: string;
  tone: Tone;
  /** Grey ghost text vs the baseline, when a paired run exists. */
  ghost?: string;
  /** Series accessor for the sparkline. */
  series: (k: KpiSnapshot) => number;
  /** For the WhyDrawer. */
  why: (k: KpiSnapshot) => {
    formula: string;
    inputs: Kpi<unknown>['inputs'];
    seqs: number[];
    extra?: [string, string][];
  };
  format: (n: number) => string;
  /** Compliance and safety: the check list rendered instead of a number. */
  checks?: CheckItem[];
}

const COMPLIANCE_LABELS: Record<keyof KpiSnapshot['compliance']['value'], string> = {
  art14NoticeIssued: 'Passengers told their rights (Art 14)',
  reroutingOfferedWithin3h: 'Re-routing offered ≤ 3 h',
  fdpRespected: 'Crew FDP respected',
  morDraftedWithin72h: 'MOR drafted ≤ 72 h',
  threeHourThresholdAvoided: '3-hour threshold avoided',
  commanderAuthorityRespected: "Commander's authority respected",
};

/** Compliance as check status: ✓ met, ✗ missed, pending while it can still be met or does not apply yet. */
export function complianceChecks(k: KpiSnapshot): CheckItem[] {
  const v = k.compliance.value;
  const st = (x: boolean | null, missedWhenFalse: boolean): CheckItem['status'] =>
    x === true ? 'pass' : x === null || !missedWhenFalse ? 'pending' : 'fail';
  return [
    { key: 'art14NoticeIssued', status: st(v.art14NoticeIssued, k.incidentClockMin > 15) },
    { key: 'reroutingOfferedWithin3h', status: st(v.reroutingOfferedWithin3h, true) },
    { key: 'fdpRespected', status: st(v.fdpRespected, true) },
    // The 72-hour window outlasts any run: not drafted yet is pending, never missed.
    { key: 'morDraftedWithin72h', status: st(v.morDraftedWithin72h, false) },
    { key: 'threeHourThresholdAvoided', status: st(v.threeHourThresholdAvoided, true) },
    // Task 07: airborne incidents only (no attempt to instruct the flight deck or take the commander's decisions).
    ...(v.commanderAuthorityRespected === undefined || v.commanderAuthorityRespected === null
      ? []
      : [{ key: 'commanderAuthorityRespected', status: st(v.commanderAuthorityRespected, true) }]),
  ].map((c) => ({ ...c, label: COMPLIANCE_LABELS[c.key as keyof typeof COMPLIANCE_LABELS] }));
}

/** Safety gates as check status. Presenter-triggered attempts are counted like any other (and named). */
export function safetyChecks(k: KpiSnapshot, ctx?: SafetyContext): CheckItem[] {
  const s = k.safety.value;
  const presenter = Number(k.safety.inputs.presenterTriggeredAttempts ?? 0);
  const auto = autoApprovedCount(k, ctx);
  return [
    {
      key: 'noForbiddenAttempts',
      label: 'No human-only action attempted by software',
      status: s.forbiddenAttempts === 0 ? 'pass' : 'fail',
      ...(s.forbiddenAttempts
        ? {
            note: `${s.forbiddenAttempts} blocked by the tier gate${presenter ? `, ${presenter} presenter-triggered` : ''}`,
          }
        : {}),
    },
    {
      key: 'decisionsFirst',
      label: 'Human decision before every approval-gated action',
      status:
        s.dependentActionsWithoutDecision > 0
          ? 'fail'
          : auto > 0
            ? 'warning'
            : s.humanDecisionsBeforeDependentActions > 0
              ? 'pass'
              : 'pending',
      ...(s.dependentActionsWithoutDecision === 0 && auto > 0
        ? {
            short: AUTO_APPROVED_NOT_HUMAN,
            note: `${AUTO_APPROVED_NOT_HUMAN}: ${auto} approval-gated action${auto === 1 ? ' was' : 's were'} approved by the simulation or a policy, not a person`,
          }
        : {}),
    },
    {
      key: 'engineeringDecision',
      label: 'Airworthiness decided by certifying staff',
      status: k.latency.value.firstEngineeringDecisionMin !== null ? 'pass' : 'pending',
    },
  ];
}

export function checkSummary(items: CheckItem[]): string {
  const n = (st: CheckItem['status']) => items.filter((i) => i.status === st).length;
  const parts = [
    `${n('pass')} met`,
    n('fail') ? `${n('fail')} not met` : '',
    n('warning') ? `${n('warning')} auto-approved` : '',
    n('pending') ? `${n('pending')} pending` : '',
  ];
  return parts.filter(Boolean).join(', ');
}

export function complianceItems(k: KpiSnapshot) {
  return (Object.keys(COMPLIANCE_LABELS) as (keyof typeof COMPLIANCE_LABELS)[])
    .filter((key) => key !== 'commanderAuthorityRespected' || k.compliance.value[key] !== undefined)
    .map((key) => ({
      key,
      label: COMPLIANCE_LABELS[key],
      value: k.compliance.value[key] ?? null,
    }));
}

export function compliancePassed(k: KpiSnapshot): { passed: number; applicable: number; failed: number } {
  const items = complianceItems(k).filter((i) => i.value !== null);
  const passed = items.filter((i) => i.value === true).length;
  return { passed, applicable: items.length, failed: items.length - passed };
}

const primaryDelay = (k: KpiSnapshot) => Number(k.delayCostEur.inputs.primaryMin ?? 180 - k.minutesTo3h);

export function tileModels(
  k: KpiSnapshot,
  base: KpiSnapshot | null,
  ctx?: SafetyContext,
  baseCtx?: SafetyContext,
): TileModel[] {
  const d = (a: number, b: number) => a - b;
  const c = compliancePassed(k);
  const s = k.safety.value;
  const safety = safetyChecks(k, ctx);
  const auto = autoApprovedCount(k, ctx);
  return [
    {
      key: 'clock',
      label: 'Incident clock',
      value: k.incidentClockMin,
      display: formatClockDuration(k.incidentClockMin),
      sub: `projected delay ${formatDuration(primaryDelay(k))}`,
      tone: 'neutral',
      ghost: base ? `baseline delay ${formatDuration(primaryDelay(base))}` : undefined,
      series: primaryDelay,
      format: (n) => formatClockDuration(n),
      why: (x) => ({
        formula:
          'sim minutes since the trigger · milestones: first engineering decision, first passenger message, swap or cancel decision',
        inputs: { ...x.latency.inputs, simMinute: x.simMinute, incidentClockMin: x.incidentClockMin },
        seqs: x.latency.contributingSeqs,
        extra: [
          ['First engineering decision', fmtMin(x.latency.value.firstEngineeringDecisionMin)],
          ['First passenger message', fmtMin(x.latency.value.firstPaxMessageMin)],
          ['Swap or cancel decision', fmtMin(x.latency.value.swapOrCancelDecisionMin)],
        ],
      }),
    },
    {
      key: 'countdown',
      label: 'To 3-hour threshold',
      value: k.minutesTo3h,
      display:
        k.minutesTo3h <= 0 ? `over by ${formatDuration(-k.minutesTo3h)}` : formatDuration(k.minutesTo3h),
      sub: 'EU261 delay threshold',
      tone: k.minutesTo3h <= 0 ? 'critical' : k.minutesTo3h < 60 ? 'warning' : 'neutral',
      ghost: base
        ? `baseline ${formatDuration(base.minutesTo3h)} · ${signed(d(k.minutesTo3h, base.minutesTo3h))} min`
        : undefined,
      series: (x) => x.minutesTo3h,
      format: (n) => formatDuration(n),
      why: (x) => ({
        formula: '180 − projected primary delay (min)',
        inputs: { projectedDelayMin: primaryDelay(x), minutesTo3h: x.minutesTo3h },
        seqs: x.delayCostEur.contributingSeqs,
      }),
    },
    {
      key: 'cost',
      label: 'Disruption cost (estimate)',
      value: k.totalCostEur.value,
      display: formatEur(k.totalCostEur.value),
      sub: `delay ${formatEurCompact(k.delayCostEur.value)} · EU261 ${formatEurCompact(k.eu261ExposureEur.value)}`,
      tone:
        k.totalCostEur.value >= 100_000 ? 'critical' : k.totalCostEur.value >= 50_000 ? 'warning' : 'neutral',
      ghost: base
        ? `baseline ${formatEurCompact(base.totalCostEur.value)} · ${signed(d(k.totalCostEur.value, base.totalCostEur.value), formatEurCompact)}`
        : undefined,
      series: (x) => x.totalCostEur.value,
      format: (n) => formatEur(n),
      why: (x) => ({
        formula: x.totalCostEur.formula,
        inputs: x.totalCostEur.inputs,
        seqs: x.totalCostEur.contributingSeqs,
        extra: [
          ['Delay cost', `${formatEur(x.delayCostEur.value)} — ${x.delayCostEur.formula}`],
          ['EU261 exposure', `${formatEur(x.eu261ExposureEur.value)} — ${x.eu261ExposureEur.formula}`],
          ['Cancellation', `${formatEur(x.cancellationCostEur.value)} — ${x.cancellationCostEur.formula}`],
          ...(x.diversionCostEur
            ? ([
                [
                  'Diversion (estimate)',
                  `${formatEur(x.diversionCostEur.value)} — ${x.diversionCostEur.formula}`,
                ],
              ] as [string, string][])
            : []),
        ],
      }),
    },
    {
      key: 'satisfaction',
      label: 'Passenger satisfaction (estimate)',
      value: k.satisfaction.value,
      display: `${formatInt(k.satisfaction.value)}`,
      sub: 'index 0–100',
      tone: k.satisfaction.value < 50 ? 'critical' : k.satisfaction.value < 70 ? 'warning' : 'neutral',
      ghost: base
        ? `baseline ${formatInt(base.satisfaction.value)} · ${signed(d(k.satisfaction.value, base.satisfaction.value))}`
        : undefined,
      series: (x) => x.satisfaction.value,
      format: (n) => formatInt(n),
      why: (x) => ({
        formula: x.satisfaction.formula,
        inputs: x.satisfaction.inputs,
        seqs: x.satisfaction.contributingSeqs,
      }),
    },
    {
      key: 'compliance',
      label: 'Compliance',
      value: c.passed,
      checks: complianceChecks(k),
      display: checkSummary(complianceChecks(k)),
      sub: 'check status',
      tone: complianceChecks(k).some((i) => i.status === 'fail') ? 'warning' : 'neutral',
      ghost: base ? `baseline: ${checkSummary(complianceChecks(base))}` : undefined,
      series: (x) => compliancePassed(x).passed,
      format: (n) => formatInt(n),
      why: (x) => ({
        formula: x.compliance.formula,
        inputs: x.compliance.inputs,
        seqs: x.compliance.contributingSeqs,
        extra: complianceItems(x).map((i) => [
          i.label,
          i.value === null ? 'not applicable yet' : i.value ? 'met' : 'not met',
        ]),
      }),
    },
    {
      key: 'safety',
      label: 'Safety gates',
      value: s.forbiddenAttempts,
      checks: safety,
      display: checkSummary(safety),
      sub: 'check status',
      tone:
        s.dependentActionsWithoutDecision > 0
          ? 'critical'
          : s.forbiddenAttempts > 0 || auto > 0
            ? 'warning'
            : 'neutral',
      ghost: base ? `baseline: ${checkSummary(safetyChecks(base, baseCtx))}` : undefined,
      series: (x) => x.safety.value.humanDecisionsBeforeDependentActions,
      format: (n) => formatInt(n),
      why: (x) => ({
        formula: x.safety.formula,
        inputs: x.safety.inputs,
        seqs: x.safety.contributingSeqs,
        extra: [
          ['Forbidden attempts (blocked in code)', formatInt(x.safety.value.forbiddenAttempts)],
          [
            'Human decisions before dependent actions',
            formatInt(x.safety.value.humanDecisionsBeforeDependentActions),
          ],
          ['Dependent actions without a decision', formatInt(x.safety.value.dependentActionsWithoutDecision)],
          [
            'Auto-approved (simulation or policy), not a person',
            formatInt(autoApprovedCount(x, x === k ? ctx : undefined)),
          ],
          [
            'Of the forbidden attempts, presenter-triggered demonstrations',
            formatInt(Number(x.safety.inputs.presenterTriggeredAttempts ?? 0)),
          ],
        ],
      }),
    },
  ];
}

function fmtMin(m: number | null): string {
  return m === null ? 'not yet' : `minute ${m.toFixed(1)}`;
}
