/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Addition (async authoring): a compact, schema-bounded **patch** the Scenario Author proposes on top of a flight's
 * template scenario (instead of writing a whole scenario). Pure and browser-safe: `applyScenarioPatch` merges it;
 * the Run Lambda then validates the merged scenario (`validateScenario`) and every reference against the template's
 * seeded world (services/run/runtime/scenario-patch.ts). All text in a patch is untrusted data.
 */
import { Type, type Static } from '@sinclair/typebox';
import { literalUnion } from './ids';
import { EVIDENCE_KINDS, TwistEffectSchema, type Scenario, type ScenarioTwist } from './scenario';

const strict = { additionalProperties: false } as const;
const Text = (max: number) => Type.String({ minLength: 1, maxLength: max });

/** Upper bounds (also stated to the model): keep the Author's output small (≈ 1,500 tokens). */
export const SCENARIO_PATCH_LIMITS = {
  twists: 3,
  effectsPerTwist: 4,
  evidence: 4,
  cohorts: 8,
  narrative: 2000,
} as const;

export const ScenarioPatchSchema = Type.Object(
  {
    /** Short title (replaces the template's). */
    title: Type.Optional(Text(120)),
    /** The incident narrative, rewritten with the duty manager's details (replaces the template's). */
    narrative: Type.Optional(Text(SCENARIO_PATCH_LIMITS.narrative)),
    trigger: Type.Optional(
      Type.Object(
        {
          description: Type.Optional(Text(800)),
          /** Replaces the template's evidence. */
          evidence: Type.Optional(
            Type.Array(Type.Object({ kind: literalUnion(EVIDENCE_KINDS), text: Text(400) }, strict), {
              maxItems: SCENARIO_PATCH_LIMITS.evidence,
            }),
          ),
        },
        strict,
      ),
    ),
    /** Extra twists (appended; ids are assigned on merge). Effects use the existing TwistEffect ops. */
    twists: Type.Optional(
      Type.Array(
        Type.Object(
          {
            title: Text(120),
            description: Text(600),
            /** Omitted = manual only (the presenter injects it). */
            atMinute: Type.Optional(Type.Number({ minimum: 0, maximum: 240 })),
            effects: Type.Array(TwistEffectSchema, {
              minItems: 1,
              maxItems: SCENARIO_PATCH_LIMITS.effectsPerTwist,
            }),
          },
          strict,
        ),
        { maxItems: SCENARIO_PATCH_LIMITS.twists },
      ),
    ),
    /** Tweaks to existing cohorts (by id): passenger count and notes (e.g. a PRM detail). */
    cohorts: Type.Optional(
      Type.Array(
        Type.Object(
          {
            id: Type.String({ minLength: 1, maxLength: 64 }),
            count: Type.Optional(Type.Integer({ minimum: 1, maximum: 400 })),
            notes: Type.Optional(Text(300)),
          },
          strict,
        ),
        { maxItems: SCENARIO_PATCH_LIMITS.cohorts },
      ),
    ),
    /** Weather at the incident station (merged into the template's). */
    weather: Type.Optional(
      Type.Object(
        {
          summary: Type.Optional(Text(200)),
          windKt: Type.Optional(Type.Number({ minimum: 0, maximum: 120 })),
          tempC: Type.Optional(Type.Number({ minimum: -60, maximum: 60 })),
        },
        strict,
      ),
    ),
  },
  strict,
);
export type ScenarioPatch = Static<typeof ScenarioPatchSchema>;

/** Id prefix of twists added by a patch. */
export const PATCH_TWIST_PREFIX = 'dm-twist-';

/**
 * Merge a patch into a template scenario (pure; the template is not modified). The id, stations, aircraft, crew,
 * baseline, expectations and KPI parameters stay the template's. Unknown cohort ids are ignored here (the Run
 * Lambda's reference check rejects them before merging).
 */
export function applyScenarioPatch(template: Scenario, patch: ScenarioPatch): Scenario {
  const s: Scenario = JSON.parse(JSON.stringify(template)) as Scenario;
  if (patch.title) s.title = patch.title;
  if (patch.narrative) s.narrative = patch.narrative;
  if (patch.trigger?.description) s.trigger.description = patch.trigger.description;
  if (patch.trigger?.evidence?.length) s.trigger.evidence = patch.trigger.evidence.map((e) => ({ ...e }));
  if (patch.cohorts?.length) {
    const byId = new Map(patch.cohorts.map((c) => [c.id, c]));
    s.world.cohorts = s.world.cohorts.map((c) => {
      const p = byId.get(c.id);
      if (!p) return c;
      return {
        ...c,
        ...(p.count !== undefined ? { count: p.count } : {}),
        ...(p.notes !== undefined ? { notes: p.notes } : {}),
      };
    });
  }
  if (patch.weather) {
    const w = patch.weather;
    s.world.weather = {
      ...s.world.weather,
      ...(w.summary !== undefined ? { summary: w.summary } : {}),
      ...(w.windKt !== undefined ? { windKt: w.windKt } : {}),
      ...(w.tempC !== undefined ? { tempC: w.tempC } : {}),
    };
  }
  if (patch.twists?.length) {
    const ids = new Set(s.twists.map((t) => t.id));
    let n = 0;
    for (const t of patch.twists) {
      let id: string;
      do id = `${PATCH_TWIST_PREFIX}${++n}`;
      while (ids.has(id));
      ids.add(id);
      const twist: ScenarioTwist = {
        id,
        title: t.title,
        description: t.description,
        ...(t.atMinute !== undefined ? { atMinute: t.atMinute } : {}),
        effects: JSON.parse(JSON.stringify(t.effects)) as ScenarioTwist['effects'],
      };
      s.twists.push(twist);
    }
  }
  return s;
}
