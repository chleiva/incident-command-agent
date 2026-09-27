/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** Case → scenario: resolve the scenario id, apply the merge patch and the generic transforms, validate. */
import { getPublicScenario } from '@ica/scenarios';
import {
  validateScenario,
  type ExpectedConstraints,
  type Scenario,
  type ValidationResult,
} from '@ica/schema';
import minimal from '@ica/schema/fixtures/scenario.minimal.json' with { type: 'json' };
import type { EvalCase } from './case';

/** Scenario ids available without task 03 content (schema fixtures). */
const FIXTURE_SCENARIOS: Record<string, Scenario> = {
  [(minimal as { id: string }).id]: minimal as unknown as Scenario,
};

export function resolveScenario(id: string): Scenario | undefined {
  const s = getPublicScenario(id) ?? FIXTURE_SCENARIOS[id];
  return s ? (JSON.parse(JSON.stringify(s)) as Scenario) : undefined;
}

/** RFC 7386 JSON merge patch (pure). */
export function mergePatch(target: unknown, patch: unknown): unknown {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const out: Record<string, unknown> =
    target && typeof target === 'object' && !Array.isArray(target)
      ? { ...(target as Record<string, unknown>) }
      : {};
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (v === null) delete out[k];
    else out[k] = mergePatch(out[k], v);
  }
  return out;
}

const clampMin = (n: number) => Math.max(0, Math.round(n * 100) / 100);

/** Apply the case's content-independent transforms (pure). */
export function applyTransforms(
  s: Scenario,
  t: NonNullable<NonNullable<EvalCase['overrides']>['transforms']>,
): Scenario {
  const out: Scenario = JSON.parse(JSON.stringify(s)) as Scenario;
  if (t.twistShiftMin) {
    for (const tw of out.twists)
      if (tw.atMinute !== undefined) tw.atMinute = clampMin(tw.atMinute + t.twistShiftMin);
  }
  if (t.crewFdpMarginDeltaMin) {
    for (const c of out.world.crew) {
      if (c.status === 'operating')
        c.maxFdpMin = Math.max(1, Math.round(c.maxFdpMin + t.crewFdpMarginDeltaMin));
    }
  }
  if (t.engineerDelayMin) {
    for (const e of out.world.engineers)
      e.availableFromMinute = clampMin(e.availableFromMinute + t.engineerDelayMin);
  }
  if (t.spareDelayMin) {
    for (const sp of out.world.spares)
      sp.availableFromMinute = clampMin(sp.availableFromMinute + t.spareDelayMin);
  }
  if (t.noSpares) out.world.spares = [];
  if (t.narrativeAppend) out.narrative = `${out.narrative} ${t.narrativeAppend}`;
  return out;
}

export function scenarioForCase(c: EvalCase): ValidationResult<Scenario> | undefined {
  const base = resolveScenario(c.scenarioId);
  if (!base) return undefined;
  let s: Scenario = base;
  if (c.overrides?.scenarioPatch) s = mergePatch(s, c.overrides.scenarioPatch) as Scenario;
  if (c.overrides?.transforms) s = applyTransforms(s, c.overrides.transforms);
  return validateScenario(s);
}

/** The case's expectations, merged with the scenario's own `expected` when `inheritScenarioExpected`. */
export function effectiveExpected(c: EvalCase, s: Scenario | undefined): EvalCase['expected'] {
  const e = c.expected;
  if (!e.inheritScenarioExpected || !s) return e;
  const se: ExpectedConstraints = s.expected;
  const uniq = <T>(xs: T[]) => [...new Map(xs.map((x) => [JSON.stringify(x), x])).values()];
  return {
    ...e,
    hardConstraints: {
      ...e.hardConstraints,
      noSoftwareDeferral: e.hardConstraints.noSoftwareDeferral || se.noSoftwareDeferral,
      noFdpExtension: e.hardConstraints.noFdpExtension || se.noFdpExtension,
    },
    requiredTools: uniq([...e.requiredTools, ...se.requiredTools]),
    forbiddenTools: uniq([...e.forbiddenTools, ...se.forbiddenTools]),
    orderedPairs: uniq([...e.orderedPairs, ...se.orderedPairs]),
    latencyTargets: {
      firstPaxMessageBeforeMin: e.latencyTargets.firstPaxMessageBeforeMin ?? se.firstPaxMessageBeforeMin,
      engineerPagedBeforeMin: e.latencyTargets.engineerPagedBeforeMin ?? se.engineerPagedBeforeMin,
      decisionBeforeMin: e.latencyTargets.decisionBeforeMin ?? se.decisionBeforeMin,
    },
    referenceSummary: e.referenceSummary || se.referenceSummary,
  };
}
