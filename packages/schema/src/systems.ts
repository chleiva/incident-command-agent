/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Mocked-system state types (spec §7). Task 03 implements the logic; tasks 02 and 05 read these shapes.
 *
 * Conventions:
 * - Every entity map is keyed by the entity's natural id (see `ENTITY_KEY`).
 * - Times inside the sim are `...Minute` numbers (sim minutes since scenario start) unless named `std`/`sta`/`etd`
 *   or `reportTime` (ISO strings, same clock as `scenario.startSimTime`).
 * - AI-drafted text always carries `aiDrafted: true`.
 */
import { Type, type Static } from '@sinclair/typebox';
import { ActorSchema, HHMM_PATTERN, IataSchema, type StateSystemName, literalUnion } from './ids';
import {
  AircraftTypeSchema,
  CohortKindSchema,
  CrewRankSchema,
  EngineerLicenceSchema,
  EquipmentKindSchema,
  StandKindSchema,
} from './scenario';

const Str = Type.String();
const Minute = Type.Number();
const Opt = Type.Optional;

// ---------------------------------------------------------------- mne (maintenance & engineering / tech log)
/**
 * Addition (task 06): the aircraft's maintenance record as far as the scenario states it. A missing field means the
 * record is not available: tools and the UI show "Unknown", never a default such as passed, OK or serviceable.
 */
export const MaintenanceRecordSchema = Type.Object({
  lastCheckType: Opt(Str),
  /** ISO date of the last scheduled check. */
  lastCheckDate: Opt(Str),
  /** Recent defects on the tail, as recorded (free text). */
  defectHistory: Opt(Type.Array(Str)),
});
export type MaintenanceRecord = Static<typeof MaintenanceRecordSchema>;
/** Shown wherever a maintenance record or field is missing (task 06 §1.6). */
export const UNKNOWN = 'Unknown';

export const AircraftSchema = Type.Object({
  tail: Str,
  type: AircraftTypeSchema,
  station: IataSchema,
  status: literalUnion(['serviceable', 'unserviceable', 'aog', 'released'] as const),
  stand: Opt(Str),
  /** Addition (task 06): maintenance record fields the scenario provides (missing = Unknown). */
  maintenance: Opt(MaintenanceRecordSchema),
});
export type Aircraft = Static<typeof AircraftSchema>;

export const DefectSchema = Type.Object({
  id: Str,
  tail: Str,
  description: Str,
  ata: Opt(Str),
  status: literalUnion(['open', 'deferred', 'rectified'] as const),
  melItem: Opt(Str),
  raisedAtMinute: Minute,
  /** Only a human certifying actor may defer (enforced by the mne system). */
  deferredBy: Opt(ActorSchema),
});
export type Defect = Static<typeof DefectSchema>;

export const WORK_ORDER_STATUSES = [
  'created',
  'assigned',
  'in_progress',
  'awaiting_certification',
  'closed',
] as const;
export const WorkOrderSchema = Type.Object({
  id: Str,
  tail: Str,
  defectId: Opt(Str),
  task: Str,
  status: literalUnion(WORK_ORDER_STATUSES),
  assignedEngineerId: Opt(Str),
  createdAtMinute: Minute,
  estimatedDurationMin: Type.Number({ minimum: 0 }),
  progressPct: Type.Number({ minimum: 0, maximum: 100 }),
  /** Addition (task 03): sim minute work started (engineer on site); progress is derived from it. */
  startedAtMinute: Opt(Minute),
  /** Addition (task 06): client-generated idempotency key of the creating call. */
  requestId: Opt(Str),
});
export type WorkOrder = Static<typeof WorkOrderSchema>;

export const TechlogEntrySchema = Type.Object({
  id: Str,
  tail: Str,
  text: Str,
  status: literalUnion(['draft', 'approved'] as const),
  aiDrafted: Type.Literal(true),
});
export type TechlogEntry = Static<typeof TechlogEntrySchema>;

export const EngineeringDecisionSchema = Type.Object({
  id: Str,
  tail: Str,
  decision: literalUnion(['rectify', 'defer_mel', 'aog', 'release'] as const),
  /** Must be `kind: 'human'`. */
  decidedBy: ActorSchema,
  atMinute: Minute,
  rationale: Str,
});
export type EngineeringDecision = Static<typeof EngineeringDecisionSchema>;

// ---------------------------------------------------------------- occ (operations control / rotation)
export const FLIGHT_STATUSES = [
  'scheduled',
  'delayed',
  'boarding',
  'departed',
  'cancelled',
  'swapped',
] as const;
export const FlightSchema = Type.Object({
  flight: Str,
  tail: Str,
  from: IataSchema,
  to: IataSchema,
  std: Str,
  sta: Str,
  etd: Opt(Str),
  status: literalUnion(FLIGHT_STATUSES),
  delayMin: Type.Number({ minimum: 0 }),
  reactionaryDelayMin: Type.Number({ minimum: 0 }),
  pax: Type.Integer({ minimum: 0 }),
  /** Addition (task 03): STD as a sim minute; lets pure `tick()`s relate ISO times to the sim clock. */
  stdMinute: Opt(Minute),
  /** Addition (task 03): STA as a sim minute. */
  staMinute: Opt(Minute),
});
export type Flight = Static<typeof FlightSchema>;

export const SpareSchema = Type.Object({
  tail: Str,
  type: AircraftTypeSchema,
  station: IataSchema,
  availableFromMinute: Minute,
  /** Flight number(s) it has been assigned to by an approved swap. */
  assignedTo: Opt(Str),
});
export type Spare = Static<typeof SpareSchema>;

/**
 * Addition (task 07): an aircraft in the air (airborne incidents). Position, ETA and squawk come from the scenario
 * and the world clock; squawk and the commander's decision are set by scenario or presenter events only, never by
 * agents (the commander flies and decides the aircraft).
 */
export const SQUAWK_STATUSES = ['normal', 'pan', 'mayday'] as const;
export const COMMANDER_DECISIONS = ['continue', 'turnback', 'divert'] as const;
export const AirborneFlightSchema = Type.Object({
  flight: Str,
  tail: Str,
  phase: literalUnion(['airborne', 'approach', 'landed'] as const),
  squawk: literalUnion(SQUAWK_STATUSES),
  from: IataSchema,
  /** The planned destination. */
  plannedDestination: IataSchema,
  /** Where the aircraft is now heading (the commander's choice once made). */
  destination: IataSchema,
  /** Position at `positionAtMinute`. */
  lat: Type.Number(),
  lon: Type.Number(),
  positionAtMinute: Minute,
  altitudeFt: Type.Number({ minimum: 0 }),
  headingDeg: Type.Number({ minimum: 0, maximum: 360 }),
  /** Sim minute of landing at `destination`. */
  etaMinute: Minute,
  /** Notional fuel endurance at `positionAtMinute` (illustrative). */
  fuelEnduranceMin: Type.Number({ minimum: 0 }),
  pax: Type.Integer({ minimum: 0 }),
  commanderDecision: Opt(literalUnion(COMMANDER_DECISIONS)),
  decisionAtMinute: Opt(Minute),
  /** Sim minute it landed. */
  landedAtMinute: Opt(Minute),
  overweightLanding: Opt(Type.Boolean()),
});
export type AirborneFlight = Static<typeof AirborneFlightSchema>;

/** Addition (task 07): the commander's decisions as relayed to the ground, recorded from scenario or presenter events. */
export const CommanderLogEntrySchema = Type.Object({
  id: Str,
  atMinute: Minute,
  flight: Str,
  decision: literalUnion(COMMANDER_DECISIONS),
  airport: Opt(IataSchema),
  overweightLanding: Opt(Type.Boolean()),
  note: Str,
  /** Always "Commander": a human decision. */
  decidedBy: Str,
});
export type CommanderLogEntry = Static<typeof CommanderLogEntrySchema>;

/** `requested` (addition, task 06): an approved swap request sent to OCC, awaiting OCC's confirmation. */
export const DECISION_STATUSES = ['proposed', 'approved', 'rejected', 'executed', 'requested'] as const;
export const DecisionStatusSchema = literalUnion(DECISION_STATUSES);
export type DecisionStatus = Static<typeof DecisionStatusSchema>;

export const SwapDecisionSchema = Type.Object({
  id: Str,
  fromTail: Str,
  toTail: Str,
  flights: Type.Array(Str),
  status: DecisionStatusSchema,
  approvedBy: Opt(ActorSchema),
  /** Additions (task 06): when the request reached OCC, when OCC confirms it, and OCC's note. */
  requestedAtMinute: Opt(Minute),
  confirmAtMinute: Opt(Minute),
  occNote: Opt(Str),
});
export type SwapDecision = Static<typeof SwapDecisionSchema>;

export const CancelDecisionSchema = Type.Object({
  id: Str,
  flight: Str,
  status: DecisionStatusSchema,
  approvedBy: Opt(ActorSchema),
});
export type CancelDecision = Static<typeof CancelDecisionSchema>;

export const CurfewSchema = Type.Object({
  station: IataSchema,
  fromLocal: Type.String({ pattern: HHMM_PATTERN }),
  toLocal: Type.String({ pattern: HHMM_PATTERN }),
});
export type Curfew = Static<typeof CurfewSchema>;

// ---------------------------------------------------------------- crew
export const CrewMemberSchema = Type.Object({
  id: Str,
  name: Str,
  rank: CrewRankSchema,
  status: literalUnion(['operating', 'standby', 'assigned', 'off'] as const),
  station: IataSchema,
  reportTime: Str,
  sectorsPlanned: Type.Integer({ minimum: 0 }),
  maxFdpMin: Type.Number(),
  fdpUsedMin: Type.Number(),
  fdpRemainingMin: Type.Number(),
  assignedFlight: Opt(Str),
  /** Addition (task 06): idempotency key of the call-out that assigned this member. */
  assignmentRequestId: Opt(Str),
});
export type CrewMember = Static<typeof CrewMemberSchema>;

// ---------------------------------------------------------------- pss (passenger service / DCS)
export const COHORT_STATUSES = ['uninformed', 'informed', 'care_issued', 'rebooked', 'waiting'] as const;
export const CohortSchema = Type.Object({
  id: Str,
  kind: CohortKindSchema,
  count: Type.Integer({ minimum: 0 }),
  flight: Str,
  status: literalUnion(COHORT_STATUSES),
  firstInformedAtMinute: Opt(Minute),
  careIssued: Type.Integer({ minimum: 0, description: 'Number of care vouchers issued to this cohort' }),
  rebookedTo: Opt(Str),
  onwardDeadline: Opt(Str),
  notes: Opt(Str),
});
export type Cohort = Static<typeof CohortSchema>;

export const RebookingOptionSchema = Type.Object({
  flight: Str,
  from: IataSchema,
  to: IataSchema,
  std: Str,
  seatsAvailable: Type.Integer({ minimum: 0 }),
});
export type RebookingOption = Static<typeof RebookingOptionSchema>;

export const VoucherSchema = Type.Object({
  id: Str,
  cohortId: Str,
  kind: literalUnion(['meal', 'refreshment', 'hotel', 'transport'] as const),
  valueEur: Type.Number({ minimum: 0 }),
  issuedAtMinute: Minute,
});
export type Voucher = Static<typeof VoucherSchema>;

export const PassengerMessageSchema = Type.Object({
  id: Str,
  cohortIds: Type.Array(Str),
  channel: literalUnion(['sms', 'email', 'app'] as const),
  body: Str,
  status: literalUnion(['draft', 'pending_approval', 'sent', 'blocked'] as const),
  aiDrafted: Type.Literal(true),
  sentAtMinute: Opt(Minute),
  approvedBy: Opt(ActorSchema),
  /** Addition (task 06): idempotency key of the send call. */
  requestId: Opt(Str),
});
export type PassengerMessage = Static<typeof PassengerMessageSchema>;

// ---------------------------------------------------------------- airport
export const StandSchema = Type.Object({
  id: Str,
  station: IataSchema,
  kind: StandKindSchema,
  occupiedByTail: Opt(Str),
  occupiedUntilMinute: Opt(Minute),
});
export type Stand = Static<typeof StandSchema>;

export const StandRequestSchema = Type.Object({
  id: Str,
  standId: Str,
  tail: Str,
  status: literalUnion(['requested', 'confirmed', 'rejected'] as const),
  confirmAtMinute: Minute,
  /** Addition (task 06): idempotency key of the creating call. */
  requestId: Opt(Str),
});
export type StandRequest = Static<typeof StandRequestSchema>;

/** `medical`, `police` (additions, task 07): services meeting an aircraft on arrival. */
export const RESOURCE_KINDS = ['bus', 'stairs', 'tow', 'gpu', 'fire_service', 'medical', 'police'] as const;
export const ResourceRequestSchema = Type.Object({
  id: Str,
  kind: literalUnion(RESOURCE_KINDS),
  station: IataSchema,
  status: literalUnion(['requested', 'confirmed', 'en_route', 'on_site', 'released'] as const),
  etaMinute: Minute,
  /** Addition (task 03): sim minute the resource is released (equipment returned to the pool). */
  releaseAtMinute: Opt(Minute),
  /** Addition (task 03): the tail the resource serves. */
  tail: Opt(Str),
  /** Addition (task 06): idempotency key of the creating call. */
  requestId: Opt(Str),
});
export type ResourceRequest = Static<typeof ResourceRequestSchema>;

export const WeatherSchema = Type.Object({
  station: IataSchema,
  summary: Str,
  windKt: Opt(Type.Number()),
  tempC: Opt(Type.Number()),
  metar: Opt(Str),
});
export type Weather = Static<typeof WeatherSchema>;

// ---------------------------------------------------------------- handler
export const HandlerTaskSchema = Type.Object({
  id: Str,
  station: IataSchema,
  /** Free-form task kind, e.g. 'tow', 'stairs', 'offload_bags', 'fuel_spill_cleanup'. */
  kind: Str,
  status: literalUnion(['queued', 'acknowledged', 'in_progress', 'done'] as const),
  ackAtMinute: Minute,
  note: Str,
  /** Addition (task 03): sim minute the task completes (it starts at acknowledgement). */
  doneAtMinute: Opt(Minute),
  /** Addition (task 03): the tail the task concerns. */
  tail: Opt(Str),
  /** Addition (task 03): equipment pool the task holds; restored when done. */
  equipmentKind: Opt(EquipmentKindSchema),
  /** Addition (task 06): idempotency key of the creating call. */
  requestId: Opt(Str),
});
export type HandlerTask = Static<typeof HandlerTaskSchema>;

export const EquipmentPoolSchema = Type.Object({
  /** `${station}:${kind}` (addition: gives the pool a single-string key). */
  id: Str,
  station: IataSchema,
  kind: EquipmentKindSchema,
  available: Type.Integer({ minimum: 0 }),
  total: Type.Integer({ minimum: 0 }),
});
export type EquipmentPool = Static<typeof EquipmentPoolSchema>;

export const OccurrenceReportSchema = Type.Object({
  id: Str,
  station: IataSchema,
  text: Str,
  status: literalUnion(['draft', 'filed_by_human'] as const),
});
export type OccurrenceReport = Static<typeof OccurrenceReportSchema>;

// ---------------------------------------------------------------- engineers
export const EngineerSchema = Type.Object({
  id: Str,
  name: Str,
  station: IataSchema,
  licence: EngineerLicenceSchema,
  skills: Type.Array(Str),
  status: literalUnion(['available', 'paged', 'travelling', 'on_site', 'busy'] as const),
  /** Station IATA code, or 'enroute'. */
  location: Str,
  etaMinute: Opt(Minute),
  /** Addition (task 03): while `busy`, the sim minute the engineer becomes available again. */
  availableFromMinute: Opt(Minute),
  travelMode: Opt(literalUnion(['drive', 'fly', 'walk'] as const)),
  /** Station the engineer is travelling to (addition). */
  destination: Opt(IataSchema),
  /** Addition (task 06): idempotency key of the page that set the current ETA. */
  pageRequestId: Opt(Str),
});
export type Engineer = Static<typeof EngineerSchema>;

// ---------------------------------------------------------------- record (incident record; not an airline system)
export const TimelineEntrySchema = Type.Object({
  id: Str,
  atMinute: Minute,
  text: Str,
  /** Role, 'world', 'human' or a system name. */
  source: Str,
});
export type TimelineEntry = Static<typeof TimelineEntrySchema>;

export const ReportDraftSchema = Type.Object({
  id: Str,
  kind: literalUnion(['occurrence', 'discretion'] as const),
  body: Str,
  status: Type.Literal('draft'),
  forHumanReporter: Type.Literal(true),
  /** Addition: AI transparency. */
  aiDrafted: Opt(Type.Literal(true)),
  createdAtMinute: Opt(Minute),
});
export type ReportDraft = Static<typeof ReportDraftSchema>;

export const EvidencePackSchema = Type.Object({
  id: Str,
  createdAtMinute: Minute,
  /**
   * Assembled by task 03's `export_evidence_pack`: timeline, decisions with approvers, messages sent,
   * report drafts, KPI snapshot, citations. Kept open so the tool can evolve; the UI renders it to PDF.
   */
  contents: Type.Object({
    timeline: Opt(Type.Array(Type.Unknown())),
    decisions: Opt(Type.Array(Type.Unknown())),
    messages: Opt(Type.Array(Type.Unknown())),
    reports: Opt(Type.Array(Type.Unknown())),
    kpis: Opt(Type.Unknown()),
    citations: Opt(Type.Array(Type.Unknown())),
  }),
});
export type EvidencePack = Static<typeof EvidencePackSchema>;

// ---------------------------------------------------------------- registry of systems → entities
/** Entity names per system; the inspector uses this for tabs. Order is display order. */
export const SYSTEM_ENTITIES = {
  mne: ['aircraft', 'defects', 'workOrders', 'techlog', 'decisions'],
  occ: ['flights', 'spares', 'swaps', 'cancellations', 'curfews', 'airborne', 'commanderLog'],
  crew: ['crew'],
  pss: ['cohorts', 'rebookingOptions', 'vouchers', 'messages'],
  airport: ['stands', 'standRequests', 'resourceRequests', 'weather'],
  handler: ['tasks', 'equipment', 'reports'],
  engineers: ['engineers'],
  record: ['timeline', 'reports', 'evidencePacks'],
} as const satisfies Record<StateSystemName, readonly string[]>;

/** Which field of each entity is its key in the entity map. */
export const ENTITY_KEY = {
  mne: { aircraft: 'tail', defects: 'id', workOrders: 'id', techlog: 'id', decisions: 'id' },
  occ: {
    flights: 'flight',
    spares: 'tail',
    swaps: 'id',
    cancellations: 'id',
    curfews: 'station',
    airborne: 'flight',
    commanderLog: 'id',
  },
  crew: { crew: 'id' },
  pss: { cohorts: 'id', rebookingOptions: 'flight', vouchers: 'id', messages: 'id' },
  airport: { stands: 'id', standRequests: 'id', resourceRequests: 'id', weather: 'station' },
  handler: { tasks: 'id', equipment: 'id', reports: 'id' },
  engineers: { engineers: 'id' },
  record: { timeline: 'id', reports: 'id', evidencePacks: 'id' },
} as const;

/** Entity TS types per system/entity. */
export interface SystemEntityTypes {
  mne: {
    aircraft: Aircraft;
    defects: Defect;
    workOrders: WorkOrder;
    techlog: TechlogEntry;
    decisions: EngineeringDecision;
  };
  occ: {
    flights: Flight;
    spares: Spare;
    swaps: SwapDecision;
    cancellations: CancelDecision;
    curfews: Curfew;
    airborne: AirborneFlight;
    commanderLog: CommanderLogEntry;
  };
  crew: { crew: CrewMember };
  pss: { cohorts: Cohort; rebookingOptions: RebookingOption; vouchers: Voucher; messages: PassengerMessage };
  airport: {
    stands: Stand;
    standRequests: StandRequest;
    resourceRequests: ResourceRequest;
    weather: Weather;
  };
  handler: { tasks: HandlerTask; equipment: EquipmentPool; reports: OccurrenceReport };
  engineers: { engineers: Engineer };
  record: { timeline: TimelineEntry; reports: ReportDraft; evidencePacks: EvidencePack };
}

/** Entity JSON Schemas per system/entity (for tests, inspectors and mutation validation). */
export const SYSTEM_ENTITY_SCHEMAS = {
  mne: {
    aircraft: AircraftSchema,
    defects: DefectSchema,
    workOrders: WorkOrderSchema,
    techlog: TechlogEntrySchema,
    decisions: EngineeringDecisionSchema,
  },
  occ: {
    flights: FlightSchema,
    spares: SpareSchema,
    swaps: SwapDecisionSchema,
    cancellations: CancelDecisionSchema,
    curfews: CurfewSchema,
    airborne: AirborneFlightSchema,
    commanderLog: CommanderLogEntrySchema,
  },
  crew: { crew: CrewMemberSchema },
  pss: {
    cohorts: CohortSchema,
    rebookingOptions: RebookingOptionSchema,
    vouchers: VoucherSchema,
    messages: PassengerMessageSchema,
  },
  airport: {
    stands: StandSchema,
    standRequests: StandRequestSchema,
    resourceRequests: ResourceRequestSchema,
    weather: WeatherSchema,
  },
  handler: { tasks: HandlerTaskSchema, equipment: EquipmentPoolSchema, reports: OccurrenceReportSchema },
  engineers: { engineers: EngineerSchema },
  record: { timeline: TimelineEntrySchema, reports: ReportDraftSchema, evidencePacks: EvidencePackSchema },
} as const;

/** Typed state of one system: `{ [entity]: { [id]: Entity } }`. */
export type SystemStateOf<S extends StateSystemName> = {
  [E in keyof SystemEntityTypes[S]]: Record<string, SystemEntityTypes[S][E]>;
};

/**
 * The full mock state of a run: `state[system][entity][id] = entity`.
 * Includes the `record` store (addition: it is persisted the same way as the seven systems).
 */
export type SystemState = { [S in StateSystemName]: SystemStateOf<S> };

/** Loosely-typed view for generic code (reducer, store, inspector). */
export type AnyEntity = Record<string, unknown>;
export type LooseSystemState = Record<string, Record<string, Record<string, AnyEntity>>>;

export type EntityName<S extends StateSystemName> = keyof SystemEntityTypes[S] & string;

/** A `SystemState` with every system/entity map present and empty. */
export function emptySystemState(): SystemState {
  const out: Record<string, Record<string, Record<string, unknown>>> = {};
  for (const [system, entities] of Object.entries(SYSTEM_ENTITIES)) {
    out[system] = {};
    for (const entity of entities) out[system][entity] = {};
  }
  return out as unknown as SystemState;
}
