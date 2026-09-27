/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Scenario schema (spec §8), `schemaVersion: 1`. Emitted as `scenario.schema.json` via `npm run -w @ica/schema gen`.
 * All free text (narrative, descriptions, evidence, twist info) is UNTRUSTED data: it is always delivered to agents
 * inside a `<scenario_data>` / `<twist_data>` wrapper, never interpolated into a system prompt.
 */
import { Type, type Static } from '@sinclair/typebox';
import {
  FlightNumberSchema,
  HhMmSchema,
  IataSchema,
  IsoDateTimeSchema,
  SCENARIO_ID_PATTERN,
  SystemNameSchema,
  TailSchema,
  literalUnion,
} from './ids';

const strict = { additionalProperties: false } as const;
const NonEmpty = Type.String({ minLength: 1 });
const Minute = Type.Number({ minimum: 0, description: 'Sim minutes since scenario start' });
const Count = Type.Integer({ minimum: 0 });

export const AIRCRAFT_TYPES = ['A319', 'A320', 'A321', 'B737', 'B738', 'E190'] as const;
export const AircraftTypeSchema = literalUnion(AIRCRAFT_TYPES);
export type AircraftType = Static<typeof AircraftTypeSchema>;

export const ENGINEER_LICENCES = ['B1', 'B2', 'A', 'B1+B2'] as const;
export const EngineerLicenceSchema = literalUnion(ENGINEER_LICENCES);
export type EngineerLicence = Static<typeof EngineerLicenceSchema>;

export const CREW_RANKS = ['CPT', 'FO', 'SCCM', 'CC'] as const;
export const CrewRankSchema = literalUnion(CREW_RANKS);
export type CrewRank = Static<typeof CrewRankSchema>;

export const COHORT_KINDS = [
  'connections',
  'prm',
  'families',
  'unaccompanied_minors',
  'general',
  'premium',
] as const;
export const CohortKindSchema = literalUnion(COHORT_KINDS);
export type CohortKind = Static<typeof CohortKindSchema>;

export const STAND_KINDS = ['contact', 'remote'] as const;
export const StandKindSchema = literalUnion(STAND_KINDS);
export type StandKind = Static<typeof StandKindSchema>;

export const EQUIPMENT_KINDS = ['tug', 'towbar', 'stairs', 'bus', 'gpu', 'acu', 'catering'] as const;
export const EquipmentKindSchema = literalUnion(EQUIPMENT_KINDS);
export type EquipmentKind = Static<typeof EquipmentKindSchema>;

export const EVIDENCE_KINDS = ['photo-description', 'techlog', 'report', 'sensor'] as const;

export const SectorSchema = Type.Object(
  {
    flight: FlightNumberSchema,
    from: IataSchema,
    to: IataSchema,
    std: IsoDateTimeSchema,
    pax: Count,
    distanceKm: Type.Number({ minimum: 0 }),
  },
  strict,
);
export type Sector = Static<typeof SectorSchema>;

/**
 * Addition (task 06): maintenance record fields as far as the scenario knows them. Anything omitted is shown as
 * "Unknown" (never a default such as passed, OK or serviceable).
 */
export const ScenarioMaintenanceSchema = Type.Object(
  {
    lastCheckType: Type.Optional(NonEmpty),
    lastCheckDate: Type.Optional(Type.String({ format: 'date' })),
    defectHistory: Type.Optional(Type.Array(NonEmpty)),
  },
  strict,
);

export const ScenarioAircraftSchema = Type.Object(
  {
    tail: TailSchema,
    type: AircraftTypeSchema,
    station: IataSchema,
    stand: Type.Optional(NonEmpty),
    nextSectors: Type.Array(SectorSchema),
    /** Addition (task 06). */
    maintenance: Type.Optional(ScenarioMaintenanceSchema),
  },
  strict,
);

export const EvidenceSchema = Type.Object({ kind: literalUnion(EVIDENCE_KINDS), text: NonEmpty }, strict);

export const TriggerSchema = Type.Object(
  {
    type: Type.String({
      minLength: 1,
      description:
        "e.g. 'ground-damage', 'bird-strike', 'lightning', 'system-warning', 'fuel-spill', 'brake-overheat'",
    }),
    atMinute: Minute,
    description: NonEmpty,
    evidence: Type.Array(EvidenceSchema),
  },
  strict,
);

export const ScenarioSpareSchema = Type.Object(
  {
    tail: TailSchema,
    type: AircraftTypeSchema,
    station: IataSchema,
    availableFromMinute: Minute,
    stand: Type.Optional(NonEmpty),
    /** Addition (task 06). */
    maintenance: Type.Optional(ScenarioMaintenanceSchema),
  },
  strict,
);

export const ScenarioEngineerSchema = Type.Object(
  {
    id: NonEmpty,
    name: Type.String({ minLength: 1, description: 'Fictional name' }),
    station: IataSchema,
    licence: EngineerLicenceSchema,
    skills: Type.Array(NonEmpty),
    availableFromMinute: Minute,
  },
  strict,
);

export const ScenarioCrewSchema = Type.Object(
  {
    id: NonEmpty,
    name: Type.String({ minLength: 1, description: 'Fictional name' }),
    rank: CrewRankSchema,
    status: literalUnion(['operating', 'standby'] as const),
    station: IataSchema,
    reportTime: IsoDateTimeSchema,
    sectorsPlanned: Count,
    maxFdpMin: Type.Integer({ minimum: 1 }),
  },
  strict,
);

export const ScenarioCohortSchema = Type.Object(
  {
    id: NonEmpty,
    kind: CohortKindSchema,
    count: Type.Integer({ minimum: 1 }),
    flight: FlightNumberSchema,
    notes: Type.Optional(Type.String()),
    onwardDeadline: Type.Optional(IsoDateTimeSchema),
  },
  strict,
);

export const ScenarioStandSchema = Type.Object(
  {
    id: NonEmpty,
    station: IataSchema,
    kind: StandKindSchema,
    occupiedByTail: Type.Optional(TailSchema),
    occupiedUntilMinute: Type.Optional(Minute),
  },
  strict,
);

export const ScenarioHandlerSchema = Type.Object(
  {
    station: IataSchema,
    name: Type.String({ minLength: 1, description: 'Fictional handling company name' }),
    staffOnShift: Count,
    equipment: Type.Array(Type.Object({ kind: EquipmentKindSchema, count: Count }, strict)),
    ackMinutes: Type.Number({ minimum: 0 }),
  },
  strict,
);

export const ScenarioWeatherSchema = Type.Object(
  {
    station: IataSchema,
    summary: NonEmpty,
    windKt: Type.Optional(Type.Number({ minimum: 0 })),
    tempC: Type.Optional(Type.Number()),
    metar: Type.Optional(Type.String()),
  },
  strict,
);

export const ScenarioCurfewSchema = Type.Object(
  { station: IataSchema, fromLocal: HhMmSchema, toLocal: HhMmSchema },
  strict,
);

export const RotationLegSchema = Type.Object(
  {
    flight: FlightNumberSchema,
    tail: TailSchema,
    from: IataSchema,
    to: IataSchema,
    std: IsoDateTimeSchema,
    sta: IsoDateTimeSchema,
    pax: Count,
  },
  strict,
);
export type RotationLeg = Static<typeof RotationLegSchema>;

export const ScenarioWorldSchema = Type.Object(
  {
    spares: Type.Array(ScenarioSpareSchema),
    engineers: Type.Array(ScenarioEngineerSchema),
    crew: Type.Array(ScenarioCrewSchema),
    cohorts: Type.Array(ScenarioCohortSchema),
    stands: Type.Array(ScenarioStandSchema),
    /** Handler at the incident station. */
    handler: ScenarioHandlerSchema,
    /** Weather snapshot at the incident station. */
    weather: ScenarioWeatherSchema,
    curfews: Type.Array(ScenarioCurfewSchema),
    /** The day's plan for the affected tail(s) and any spare tails. */
    rotation: Type.Array(RotationLegSchema),
    /** Optional overrides; otherwise computed from airports data (haversine). */
    distanceTableKm: Type.Optional(
      Type.Record(
        Type.String({ pattern: '^[A-Z]{3}$' }),
        Type.Record(Type.String({ pattern: '^[A-Z]{3}$' }), Type.Number({ minimum: 0 })),
      ),
    ),
  },
  strict,
);
export type ScenarioWorld = Static<typeof ScenarioWorldSchema>;

export const TwistEffectSchema = Type.Union([
  Type.Object(
    {
      op: Type.Literal('patch'),
      system: SystemNameSchema,
      entity: NonEmpty,
      id: NonEmpty,
      patch: Type.Record(Type.String(), Type.Unknown()),
    },
    strict,
  ),
  Type.Object(
    {
      op: Type.Literal('create'),
      system: SystemNameSchema,
      entity: NonEmpty,
      record: Type.Record(Type.String(), Type.Unknown()),
    },
    strict,
  ),
  Type.Object({ op: Type.Literal('delay'), flight: FlightNumberSchema, minutes: Type.Number() }, strict),
  /**
   * Addition (task 06): shift a numeric sim-minute field of an existing entity by `minutes`, e.g. an engineer's
   * `etaMinute` (+40). Skipped (logged) when the entity or field does not exist yet.
   */
  Type.Object(
    {
      op: Type.Literal('shift'),
      system: SystemNameSchema,
      entity: NonEmpty,
      id: NonEmpty,
      field: NonEmpty,
      minutes: Type.Number(),
    },
    strict,
  ),
  Type.Object(
    {
      op: Type.Literal('info'),
      text: Type.String({ minLength: 1, description: 'Untrusted; shown to agents as data' }),
    },
    strict,
  ),
]);
export type TwistEffect = Static<typeof TwistEffectSchema>;

export const ScenarioTwistSchema = Type.Object(
  {
    id: NonEmpty,
    title: NonEmpty,
    /** Omitted = manual only (presenter injects it), unless `afterFirstApproval` is set. */
    atMinute: Type.Optional(Minute),
    /**
     * Addition (task 06): fire only after the first approved (or edited) proposal of the run, at or after `atMinute`
     * (default 0). Used by the engineer-ETA twist that invalidates an approval.
     */
    afterFirstApproval: Type.Optional(Type.Boolean()),
    description: NonEmpty,
    effects: Type.Array(TwistEffectSchema),
  },
  strict,
);
export type ScenarioTwist = Static<typeof ScenarioTwistSchema>;

export const BaselineActionSchema = Type.Object(
  {
    tool: Type.String({ minLength: 1, description: 'Same tool names as the agents' }),
    args: Type.Record(Type.String(), Type.Unknown()),
    decision: Type.Optional(literalUnion(['approve', 'reject'] as const)),
  },
  strict,
);
export type BaselineAction = Static<typeof BaselineActionSchema>;

export const BaselineStepSchema = Type.Object(
  {
    atMinute: Minute,
    actor: Type.String({ minLength: 1, description: "e.g. 'OCC controller'" }),
    action: BaselineActionSchema,
    note: Type.String(),
  },
  strict,
);
export type BaselineStep = Static<typeof BaselineStepSchema>;

/** `[before, after]`: tool `before` must be called before tool `after`. */
export const OrderedPairSchema = Type.Unsafe<[before: string, after: string]>({
  type: 'array',
  prefixItems: [
    { type: 'string', minLength: 1 },
    { type: 'string', minLength: 1 },
  ],
  items: false,
  minItems: 2,
  maxItems: 2,
});

export const ExpectedConstraintsSchema = Type.Object(
  {
    noSoftwareDeferral: Type.Boolean(),
    noFdpExtension: Type.Boolean(),
    firstPaxMessageBeforeMin: Type.Optional(Minute),
    engineerPagedBeforeMin: Type.Optional(Minute),
    decisionBeforeMin: Type.Optional(Minute),
    requiredTools: Type.Array(NonEmpty),
    forbiddenTools: Type.Array(NonEmpty),
    orderedPairs: Type.Array(OrderedPairSchema),
    referenceSummary: Type.String(),
  },
  strict,
);
export type ExpectedConstraints = Static<typeof ExpectedConstraintsSchema>;

export const KpiParamsSchema = Type.Object(
  {
    eurPerMinute: Type.Number({ minimum: 0, default: 100 }),
    reactionaryFactor: Type.Number({ minimum: 0, default: 1.8 }),
    /** Derived by distance if absent. */
    eu261TierEur: Type.Optional(Type.Union([Type.Literal(250), Type.Literal(400), Type.Literal(600)])),
    cancellationFixedEur: Type.Number({ minimum: 0, default: 18600 }),
    careEurPerPaxPerHour: Type.Number({ minimum: 0 }),
    accommodationEurPerPax: Type.Number({ minimum: 0 }),
  },
  strict,
);
export type KpiParams = Static<typeof KpiParamsSchema>;

export const DEFAULT_KPI_PARAMS: KpiParams = {
  eurPerMinute: 100,
  reactionaryFactor: 1.8,
  cancellationFixedEur: 18600,
  careEurPerPaxPerHour: 8,
  accommodationEurPerPax: 120,
};

export const InspiredBySchema = Type.Object(
  {
    sourceId: Type.String({
      minLength: 1,
      description: 'Verified report id, e.g. an ASRS ACN. Never invent one.',
    }),
    url: Type.String({ format: 'uri' }),
    note: Type.String(),
  },
  strict,
);

export const SCENARIO_SCHEMA_ID = 'urn:incident-command-agent:schema:scenario:1';

export const ScenarioSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    id: Type.String({ pattern: SCENARIO_ID_PATTERN }),
    title: NonEmpty,
    /** Untrusted text. */
    narrative: NonEmpty,
    visibility: literalUnion(['public', 'private'] as const),
    inspiredBy: Type.Array(InspiredBySchema),
    /** ISO; the sim clock origin (sim minute 0). */
    startSimTime: IsoDateTimeSchema,
    aircraft: ScenarioAircraftSchema,
    trigger: TriggerSchema,
    world: ScenarioWorldSchema,
    twists: Type.Array(ScenarioTwistSchema),
    baseline: Type.Array(BaselineStepSchema),
    expected: ExpectedConstraintsSchema,
    kpiParams: KpiParamsSchema,
  },
  {
    ...strict,
    $id: SCENARIO_SCHEMA_ID,
    title: 'Incident Coordination Agent scenario',
    description:
      'A ground or pre-departure incident scenario for the fictional carrier Accent Air (schemaVersion 1).',
  },
);
export type Scenario = Static<typeof ScenarioSchema>;

/** Plain JSON Schema object (TypeBox symbols stripped). */
export const scenarioJsonSchema: Record<string, unknown> = JSON.parse(JSON.stringify(ScenarioSchema));

/** The exact text written to `packages/schema/scenario.schema.json`. */
export function renderScenarioSchemaFile(): string {
  return (
    JSON.stringify(
      { $schema: 'https://json-schema.org/draft/2020-12/schema', ...scenarioJsonSchema },
      null,
      2,
    ) + '\n'
  );
}
