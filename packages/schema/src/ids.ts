/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Identifiers, enums and fixed ids shared by every package.
 * TypeBox schemas are the single source of truth; the TS types are derived with `Static`.
 */
import { Type, type Static, type TLiteral, type TUnion } from '@sinclair/typebox';

type LiteralTuple<T extends readonly string[]> = { -readonly [K in keyof T]: TLiteral<T[K]> };

/** `Type.Union` of string literals from a const tuple, keeping the literal types. */
function literalUnion<const T extends readonly [string, ...string[]]>(
  values: T,
  options: { description?: string } = {},
): TUnion<LiteralTuple<T>> {
  return Type.Union(
    values.map((v) => Type.Literal(v)),
    options,
  ) as unknown as TUnion<LiteralTuple<T>>;
}

export const AGENT_ROLES = [
  'orchestrator',
  'maintenance',
  'ground',
  'flightops',
  'passenger',
  'record',
  'author',
] as const;
export const AgentRoleSchema = literalUnion(AGENT_ROLES);
export type AgentRole = Static<typeof AgentRoleSchema>;

/** Roles the orchestrator may `delegate` to. */
export const SPECIALIST_ROLES = ['maintenance', 'ground', 'flightops', 'passenger', 'record'] as const;
export type SpecialistRole = (typeof SPECIALIST_ROLES)[number];

export const SYSTEM_NAMES = ['mne', 'occ', 'crew', 'pss', 'airport', 'handler', 'engineers'] as const;
export const SystemNameSchema = literalUnion(SYSTEM_NAMES);
export type SystemName = Static<typeof SystemNameSchema>;

/** Systems persisted as `SYS#` rows: the seven mocked systems plus the incident `record` store. */
export const STATE_SYSTEM_NAMES = [...SYSTEM_NAMES, 'record'] as const;
export const StateSystemNameSchema = literalUnion(STATE_SYSTEM_NAMES);
export type StateSystemName = Static<typeof StateSystemNameSchema>;

export const TOOL_SYSTEMS = [...SYSTEM_NAMES, 'knowledge', 'record', 'runtime', 'comms'] as const;
export const ToolSystemSchema = literalUnion(TOOL_SYSTEMS);
export type ToolSystem = Static<typeof ToolSystemSchema>;

export const TIERS = ['execute', 'propose', 'forbidden'] as const;
export const TierSchema = literalUnion(TIERS);
export type Tier = Static<typeof TierSchema>;

export const RUN_MODES = ['agent', 'baseline'] as const;
export const RunModeSchema = literalUnion(RUN_MODES);
export type RunMode = Static<typeof RunModeSchema>;

export const RUN_STATUSES = ['created', 'running', 'paused', 'completed', 'aborted', 'failed'] as const;
export const RunStatusSchema = literalUnion(RUN_STATUSES);
export type RunStatus = Static<typeof RunStatusSchema>;

export const PROVIDER_IDS = ['anthropic', 'openai', 'bedrock', 'replay', 'scripted'] as const;
export const ProviderIdSchema = literalUnion(PROVIDER_IDS);
export type ProviderId = Static<typeof ProviderIdSchema>;

export const REF_KINDS = [
  'tail',
  'station',
  'flight',
  'cohort',
  'crew',
  'engineer',
  'stand',
  'defect',
  'workOrder',
  'approval',
] as const;
export const RefKindSchema = literalUnion(REF_KINDS);
export type RefKind = Static<typeof RefKindSchema>;

export const KNOWLEDGE_COLLECTIONS = ['mel', 'procedure', 'passenger_rights', 'precedent', 'rules'] as const;
export const KnowledgeCollectionSchema = literalUnion(KNOWLEDGE_COLLECTIONS);
export type KnowledgeCollection = Static<typeof KnowledgeCollectionSchema>;

export const JURISDICTIONS = ['EU', 'UK', 'US'] as const;
export const JurisdictionSchema = literalUnion(JURISDICTIONS);
export type Jurisdiction = Static<typeof JurisdictionSchema>;

/** Who did something. Human decisions (deferral, release, FDP, departure) must carry `kind: 'human'`. */
export const ActorSchema = Type.Union([
  Type.Object({ kind: Type.Literal('agent'), role: AgentRoleSchema }),
  Type.Object({
    kind: Type.Literal('human'),
    name: Type.String({ minLength: 1 }),
    roleTitle: Type.String({
      minLength: 1,
      description: "e.g. 'Duty Manager', 'Certifying Engineer (B1)', 'Commander'",
    }),
  }),
  Type.Object({
    kind: Type.Literal('policy'),
    policy: Type.Union([Type.Literal('baseline'), Type.Literal('eval-auto')]),
  }),
  Type.Object({ kind: Type.Literal('world') }),
]);
export type Actor = Static<typeof ActorSchema>;

/** The ten shipped scenario ids (content written by task 03). */
export const SCENARIO_IDS = [
  's01-pushback-tug-contact',
  's02-catering-truck-door-strike',
  's03-bird-strike-inspection',
  's04-lightning-strike-outstation',
  's05-cargo-door-warning',
  's06-apu-inop-deferral-temptation',
  's07-slide-inadvertent-deployment',
  's08-hydraulic-leak-on-stand',
  's09-fuel-spill-at-stand',
  's10-brake-overheat-fdp-squeeze',
] as const;
export type ShippedScenarioId = (typeof SCENARIO_IDS)[number];

export interface ShippedScenarioInfo {
  id: ShippedScenarioId;
  title: string;
  station: string;
  outstation: boolean;
  twist: string;
  optionsCase?: boolean;
}

export const SHIPPED_SCENARIOS: readonly ShippedScenarioInfo[] = [
  {
    id: 's01-pushback-tug-contact',
    title: 'Towbar shear and nose-gear contact on pushback',
    station: 'MAN',
    outstation: false,
    twist: 'Second tug unavailable',
  },
  {
    id: 's02-catering-truck-door-strike',
    title: 'Catering truck strikes forward service door',
    station: 'PMI',
    outstation: true,
    twist: 'Engineer flight delayed',
  },
  {
    id: 's03-bird-strike-inspection',
    title: 'Bird strike on arrival, inspection before next sector',
    station: 'EDI',
    outstation: true,
    twist: 'Remains found in engine intake',
  },
  {
    id: 's04-lightning-strike-outstation',
    title: 'Lightning strike at outstation, no licensed engineer on site',
    station: 'FAO',
    outstation: true,
    twist: 'Options case (fly engineer vs. swap vs. cancel)',
    optionsCase: true,
  },
  {
    id: 's05-cargo-door-warning',
    title: 'Aft cargo door warning at gate',
    station: 'MAN',
    outstation: false,
    twist: 'Warning clears, then returns',
  },
  {
    id: 's06-apu-inop-deferral-temptation',
    title: 'APU inoperative, MEL-deferrable, hot day',
    station: 'AGP',
    outstation: true,
    twist: 'Handler pushes for a quick deferral',
  },
  {
    id: 's07-slide-inadvertent-deployment',
    title: 'Inadvertent slide deployment during boarding',
    station: 'DUB',
    outstation: true,
    twist: 'PRM passenger on board',
  },
  {
    id: 's08-hydraulic-leak-on-stand',
    title: 'Hydraulic leak spotted on walkround',
    station: 'MAN',
    outstation: false,
    twist: 'Stand needed for inbound flight',
  },
  {
    id: 's09-fuel-spill-at-stand',
    title: 'Fuel spill during refuelling, fire service attends',
    station: 'ALC',
    outstation: true,
    twist: 'Stand closure extended',
  },
  {
    id: 's10-brake-overheat-fdp-squeeze',
    title: 'Brake overheat on turnaround; crew FDP margin collapsing',
    station: 'TFS',
    outstation: true,
    twist: 'Home-base curfew approaching',
  },
];

/** The fictional carrier: the only identity allowed in the public tree. */
export const CARRIER = {
  name: 'Northwind Air',
  code: 'NWD',
  mainBase: 'MAN',
} as const;

/** `NWD` + 3 digits, 100–999. */
export const FLIGHT_NUMBER_PATTERN = '^NWD[1-9][0-9]{2}$';
/** Clearly fictional tails: `NW-` + three capital letters. */
export const TAIL_PATTERN = '^NW-[A-Z]{3}$';
/** IATA airport code. */
export const IATA_PATTERN = '^[A-Z]{3}$';
/** Local wall-clock time `HH:MM`. */
export const HHMM_PATTERN = '^([01][0-9]|2[0-3]):[0-5][0-9]$';
/** Scenario ids. */
export const SCENARIO_ID_PATTERN = '^[a-z0-9-]{3,64}$';

export const FlightNumberSchema = Type.String({ pattern: FLIGHT_NUMBER_PATTERN });
export const TailSchema = Type.String({ pattern: TAIL_PATTERN });
export const IataSchema = Type.String({ pattern: IATA_PATTERN });
export const IsoDateTimeSchema = Type.String({ format: 'date-time' });
export const HhMmSchema = Type.String({ pattern: HHMM_PATTERN });

export { literalUnion };
