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
import { FlightNumberSchema, IataSchema, TailSchema, literalUnion } from './ids';
import {
  COHORT_KINDS,
  EVIDENCE_KINDS,
  TRIGGER_SCOPES,
  TwistEffectSchema,
  type Scenario,
  type ScenarioTwist,
} from './scenario';
import { COMMANDER_DECISIONS, SQUAWK_STATUSES } from './systems';

const strict = { additionalProperties: false } as const;
const Text = (max: number) => Type.String({ minLength: 1, maxLength: max });

/** Upper bounds (also stated to the model): keep the Author's output small (≈ 1,500 tokens). */
export const SCENARIO_PATCH_LIMITS = {
  /** Extra twists for a typed incident (the template already has its own). */
  twists: 3,
  effectsPerTwist: 4,
  evidence: 4,
  cohorts: 8,
  narrative: 2000,
  /** Addition (authoritative free text): twists the Author may write for "Something else" (the incident layer). */
  twistsOther: 5,
  /** Addition: template twists a patch may remove. */
  removeTwists: 10,
  /** Addition: network flights a patch may bring into the scenario (network-wide events). */
  networkFlights: 25,
  networkCohortsPerFlight: 4,
  networkSpares: 5,
} as const;

/** Addition (authoritative free text): what a network-wide event does to one flight of the day's network. */
export const NETWORK_FLIGHT_EFFECTS = ['delay', 'hold', 'cancel', 'divert', 'monitor'] as const;
export type NetworkFlightEffect = (typeof NETWORK_FLIGHT_EFFECTS)[number];

const Evidence = Type.Array(Type.Object({ kind: literalUnion(EVIDENCE_KINDS), text: Text(400) }, strict), {
  maxItems: SCENARIO_PATCH_LIMITS.evidence,
});

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
          evidence: Type.Optional(Evidence),
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
        // Typed incidents are held to `twists` (3) by the Run Lambda's check; "Something else" to `twistsOther`.
        { maxItems: SCENARIO_PATCH_LIMITS.twistsOther },
      ),
    ),
    /** Addition: ids of template twists that contradict the description (removed before merging). */
    removeTwistIds: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 64 }), {
        maxItems: SCENARIO_PATCH_LIMITS.removeTwists,
      }),
    ),
    /** Addition: the narrative, rewritten from the description (replaces the template's; wins over `narrative`). */
    replaceNarrative: Type.Optional(Text(SCENARIO_PATCH_LIMITS.narrative)),
    /** Addition: the trigger, rewritten from the description (replaces the template's; wins over `trigger`). */
    replaceTrigger: Type.Optional(
      Type.Object(
        {
          /** Free-form kebab-case, e.g. 'airspace-closure', 'volcanic-ash', 'fumes'. */
          type: Type.Optional(Type.String({ pattern: '^[a-z][a-z0-9-]{1,39}$' })),
          scope: Type.Optional(literalUnion(TRIGGER_SCOPES)),
          description: Text(800),
          evidence: Type.Optional(Evidence),
        },
        strict,
      ),
    ),
    /**
     * Addition: the commander's decision for the incident flight, as relayed to the ground (airborne only). Replaces
     * the template's commander-decision twist. Still the Commander's decision: agents never decide it.
     */
    commanderDecision: Type.Optional(
      Type.Object(
        {
          atMinute: Type.Number({ minimum: 0, maximum: 60 }),
          decision: literalUnion(COMMANDER_DECISIONS),
          /** Required for `divert`; `turnback` returns to the departure airport. */
          airport: Type.Optional(IataSchema),
          squawk: Type.Optional(literalUnion(SQUAWK_STATUSES)),
          overweightLanding: Type.Optional(Type.Boolean()),
          note: Text(300),
        },
        strict,
      ),
    ),
    /**
     * Addition: a network-wide event. Flights must come from the day's network slice given to the Author; the Run
     * Lambda resolves them from the schedule (route, tail, times, position) — the Author never writes those.
     */
    network: Type.Optional(
      Type.Object(
        {
          flights: Type.Array(
            Type.Object(
              {
                flight: FlightNumberSchema,
                effect: literalUnion(NETWORK_FLIGHT_EFFECTS),
                /** Delay/hold minutes. */
                minutes: Type.Optional(Type.Integer({ minimum: 1, maximum: 720 })),
                /** Divert only (the commander's decision of that flight, relayed). */
                divertTo: Type.Optional(IataSchema),
                /** When it happens (sim minutes; default 0 = the world state at the start). */
                atMinute: Type.Optional(Type.Number({ minimum: 0, maximum: 240 })),
                note: Type.Optional(Text(300)),
                /** Passenger groups (bounded by the flight's booked passengers). Default: one general cohort. */
                cohorts: Type.Optional(
                  Type.Array(
                    Type.Object(
                      {
                        kind: literalUnion(COHORT_KINDS),
                        count: Type.Integer({ minimum: 1, maximum: 400 }),
                        notes: Type.Optional(Text(200)),
                      },
                      strict,
                    ),
                    { maxItems: SCENARIO_PATCH_LIMITS.networkCohortsPerFlight },
                  ),
                ),
              },
              strict,
            ),
            { maxItems: SCENARIO_PATCH_LIMITS.networkFlights },
          ),
          /** Extra spare aircraft: tails from the network slice, at a network station. */
          spares: Type.Optional(
            Type.Array(
              Type.Object(
                {
                  tail: TailSchema,
                  station: IataSchema,
                  availableFromMinute: Type.Number({ minimum: 0, maximum: 600 }),
                },
                strict,
              ),
              { maxItems: SCENARIO_PATCH_LIMITS.networkSpares },
            ),
          ),
        },
        strict,
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
 * Lambda's reference check rejects them before merging). `commanderDecision` and `network` need the day's network
 * (positions, routes): they are merged by `applyAuthoredPatch` in `@ica/network/templates`, not here.
 */
export function applyScenarioPatch(template: Scenario, patch: ScenarioPatch): Scenario {
  const s: Scenario = JSON.parse(JSON.stringify(template)) as Scenario;
  if (patch.title) s.title = patch.title;
  if (patch.removeTwistIds?.length) {
    const drop = new Set(patch.removeTwistIds);
    s.twists = s.twists.filter((t) => !drop.has(t.id));
  }
  const narrative = patch.replaceNarrative ?? patch.narrative;
  if (narrative) s.narrative = narrative;
  const rt = patch.replaceTrigger;
  if (rt) {
    s.trigger.description = rt.description;
    s.trigger.evidence = (rt.evidence ?? []).map((e) => ({ ...e }));
    if (rt.type) s.trigger.type = rt.type;
    if (rt.scope) s.trigger.scope = rt.scope;
  } else {
    if (patch.trigger?.description) s.trigger.description = patch.trigger.description;
    if (patch.trigger?.evidence?.length) s.trigger.evidence = patch.trigger.evidence.map((e) => ({ ...e }));
  }
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
