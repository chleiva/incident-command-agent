/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Plain-language headlines for agent actions (task 08), generated in code from the tool, its arguments and its
 * result. Never from model text (thoughts, summaries, reasoning), never with internal identifiers (work-order,
 * engineer, request, message, cohort or tool-call ids) and never with tool or parameter names. Human-meaningful
 * identifiers are fine: flight numbers, tails, stations, stands, cohort names, people's (fictional) names.
 *
 * Every rendered headline is at most `HEADLINE_MAX` characters, so it wraps to two lines at most in a ~300 px
 * column on a 1080p projector. Free text (timeline entries, queries, titles) is clipped with an ellipsis.
 *
 * One template per tool: every domain tool (services/run/tools), every runtime tool (open_incident, set_objective,
 * delegate, request_decision, report) and the Scenario Author's patch tool. `headline.test.ts` fails when a tool
 * in the registry has no template.
 */
import type { AgentRole } from '@ica/schema/browser';
import { roleName } from './roles';

export const HEADLINE_MAX = 60;

type Args = Record<string, unknown>;

export interface HeadlineContext {
  /** Sim minute of the call (turns an absolute ETA minute into "ETA 9 min"). */
  minute?: number;
  /** The call's result was an error. */
  failed?: boolean;
}

// ------------------------------------------------------------------------------------------------ text helpers
/** Clip to `max` characters with an ellipsis, preferring a word boundary. */
export function clipText(text: string, max: number): string {
  const s = text.replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  if (max <= 1) return '…';
  const cut = s.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  const base = space > max * 0.6 ? cut.slice(0, space) : cut;
  return `${base.replace(/[\s,;:.–—-]+$/, '')}…`;
}

/** The whole headline within the limit. */
export function fitHeadline(text: string): string {
  return clipText(text, HEADLINE_MAX);
}

/** `prefix` + free text clipped so the whole line fits. */
function withText(prefix: string, text: unknown, suffix = ''): string {
  const t = str(text);
  if (!t) return (prefix.replace(/[:\s]+$/, '') + suffix).trim();
  const room = HEADLINE_MAX - prefix.length - suffix.length;
  return `${prefix}${clipText(t, Math.max(8, room))}${suffix}`;
}

function str(v: unknown): string {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return '';
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function obj(v: unknown): Args {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Args) : {};
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "unaccompanied_minors" → "unaccompanied minors". */
const words = (s: string) => s.replace(/[_-]+/g, ' ').trim();

/** Human-meaningful identifiers only: a flight number, tail, station or stand; never an internal id. */
const FLIGHT = /^[A-Z0-9]{2,3}\d{1,4}[A-Z]?$/;
const TAIL = /^[A-Z0-9]{1,2}-[A-Z0-9]{3,5}$/;
const IATA = /^[A-Z]{3}$/;
const STAND = /^[A-Z]?\d{1,3}[A-Z]?$/;
const flight = (v: unknown) => (FLIGHT.test(str(v)) ? str(v) : '');
const tail = (v: unknown) => (TAIL.test(str(v)) ? str(v) : '');
const station = (v: unknown) => (IATA.test(str(v)) ? str(v) : '');
const stand = (v: unknown) => (STAND.test(str(v)) ? str(v) : '');

/** " at MAN", " for AX-KES" — or nothing when the value is missing or not human-meaningful. */
const at = (v: string) => (v ? ` at ${v}` : '');
const forX = (v: string) => (v ? ` for ${v}` : '');
const on = (v: string) => (v ? ` on ${v}` : '');

/** A result may arrive as the full `result` or only as the JSON `resultPreview`. */
export function resultData(result: unknown, preview?: string): Args {
  if (result && typeof result === 'object') return result as Args;
  if (preview) {
    try {
      const parsed = JSON.parse(preview) as unknown;
      return obj(parsed);
    } catch {
      return {};
    }
  }
  return {};
}

const TASK_LABEL: Record<string, string> = {
  damage_assessment: 'damage assessment',
  bird_strike_inspection: 'bird strike inspection',
  lightning_strike_inspection: 'lightning strike inspection',
  borescope_inspection: 'engine borescope inspection',
  door_inspection_and_rigging_check: 'door inspection',
  sensor_troubleshooting: 'sensor troubleshooting',
  apu_troubleshooting: 'APU troubleshooting',
  hydraulic_leak_check: 'hydraulic leak check',
  brake_cooling_and_inspection: 'brake cooling and inspection',
  slide_reinstatement: 'escape slide reinstatement',
  fuel_leak_inspection: 'fuel leak inspection',
  structural_repair_assessment: 'structural repair assessment',
  component_replacement: 'component replacement',
  general_visual_inspection: 'general visual inspection',
};

const HANDLER_TASK_LABEL: Record<string, string> = {
  tow: 'a tow',
  stairs: 'stairs',
  gpu: 'ground power',
  acu: 'air conditioning',
  offload_bags: 'bags offloaded',
  hold_loading: 'loading held',
  hold_boarding: 'boarding held',
  deboard_passengers: 'passengers taken off',
  fuel_spill_cleanup: 'a fuel-spill clean-up',
  cabin_clean: 'a cabin clean',
  catering_hold: 'catering held',
  marshalling: 'marshalling',
  damage_inspection_access: 'inspection access',
  foreign_object_sweep: 'a debris sweep',
  prm_assistance: 'assistance for reduced mobility',
  diversion_handling: 'diversion handling',
  refuel: 'refuelling',
  catering_uplift: 'catering',
  hotel_hold: 'hotel rooms on hold',
  station_notification: 'a station notification',
};

const SERVICE_LABEL: Record<string, string> = {
  fire_standby: 'fire cover',
  medical: 'a medical team',
  police: 'police',
  handling: 'handling',
  stairs: 'stairs',
  disembark: 'disembarkation',
  fuel: 'fuel',
  catering: 'catering',
  hotel_hold: 'hotel holds',
  prm_assistance: 'assistance',
};

const DECISION_LABEL: Record<string, string> = {
  rectify: 'rectify',
  defer_mel: 'defer under the MEL',
  aog: 'aircraft on ground',
  release: 'release',
};

function listLabels(values: unknown[], labels: Record<string, string>, max = 2): string {
  const names = values.map((v) => labels[str(v)] ?? words(str(v))).filter(Boolean);
  if (!names.length) return '';
  if (names.length <= max) return names.join(' and ');
  return `${names.slice(0, max).join(', ')} +${names.length - max}`;
}

function eur(n: number): string {
  return `€${Math.round(n).toLocaleString('en-GB')}`;
}

function groups(ids: unknown): string {
  const n = arr(ids).length;
  return n ? plural(n, 'passenger group') : 'passengers';
}

// ------------------------------------------------------------------------------------------------ plain labels
/**
 * The plain label of every tool (an action in words). Used by the fallback template ("Called {label}") and by the
 * waiting row ("Waiting for a decision: {label}"). Raw tool names are never shown.
 */
export const TOOL_LABEL: Record<string, string> = {
  // runtime
  open_incident: 'open the incident',
  set_objective: 'set the objective',
  delegate: 'brief a specialist',
  request_decision: 'choose between options',
  report: 'report back',
  // maintenance
  get_aircraft_status: 'check the aircraft status',
  get_open_defects: 'check open defects',
  search_mel: 'search the MEL',
  create_work_order: 'raise a work order',
  page_engineer: 'page an engineer',
  draft_techlog_entry: 'draft a tech log entry',
  record_engineering_decision: 'record the engineering decision',
  defer_defect: 'defer a defect',
  release_aircraft: 'release the aircraft to service',
  // ground
  get_stand_status: 'check the stands',
  request_stand: 'request a stand',
  request_tow: 'request a tow',
  request_bus: 'request buses',
  notify_handler: 'task the ground handler',
  search_procedure: 'look up a procedure',
  get_weather: 'check the weather',
  // flight ops
  get_rotation: "check the aircraft's flights",
  find_spare_aircraft: 'look for a spare aircraft',
  get_crew_fdp: 'check crew duty time',
  find_standby_crew: 'look for standby crew',
  propose_swap: 'swap the aircraft',
  propose_cancel: 'cancel a flight',
  assign_standby_crew: 'assign standby crew',
  extend_crew_fdp: 'extend a crew duty period',
  // passengers
  get_manifest_summary: 'check the passengers',
  estimate_eu261_exposure: 'estimate compensation exposure',
  search_passenger_rights: 'look up passenger rights',
  draft_passenger_message: 'draft a passenger message',
  send_passenger_message: 'send a passenger message',
  issue_care_vouchers: 'issue care vouchers',
  rebook_cohort: 'rebook passengers',
  // record
  append_timeline: 'log to the incident record',
  draft_occurrence_report: 'draft the occurrence report',
  draft_discretion_report: 'draft the discretion report',
  export_evidence_pack: 'export the evidence pack',
  // airborne
  get_flight_position: 'check the flight position',
  rank_diversion_airports: 'rank diversion airports',
  prepare_diversion_handling: 'book diversion handling',
  arrange_arrival_services: 'arrange arrival services',
  notify_destination_station: 'notify the arrival station',
  plan_overweight_landing_inspection: 'plan an overweight-landing inspection',
  instruct_flight_crew: 'instruct the flight crew',
  select_diversion_airport: 'choose the diversion airport',
  approve_overweight_landing: 'approve an overweight landing',
  // scenario author
  validate_scenario: 'check the scenario',
  lookup_airport: 'look up an airport',
  search_precedents: 'search past incidents',
  web_search: 'search the web',
  propose_scenario_patch: 'change the scenario',
};

/** "Look for a spare aircraft" (sentence case), or a neutral phrase for an unknown tool. */
export function toolLabel(tool: string, sentence = false): string {
  const label = TOOL_LABEL[tool] ?? 'use a tool';
  return sentence ? label.charAt(0).toUpperCase() + label.slice(1) : label;
}

// ------------------------------------------------------------------------------------------------ templates
type Template = (a: Args, r: Args, ctx: HeadlineContext) => string;

/** A propose-tier action reads "Proposed …" until its (approved) result arrives. */
const done = (r: Args) => Object.keys(r).length > 0;

const search =
  (what: string): Template =>
  (a, r) => {
    const hits = Array.isArray(r.hits) ? r.hits.length : (num(r.hits) ?? arr(r.results).length);
    const suffix = done(r) ? ` — ${hits === 0 ? 'nothing found' : `${hits} found`}` : '';
    return withText(`${what}: `, a.query, suffix);
  };

const tried =
  (text: (a: Args) => string): Template =>
  (a) =>
    `Tried to ${text(a)}`;

export const HEADLINE_TEMPLATES: Record<string, Template> = {
  // ---------------------------------------------------------------- runtime
  open_incident: (a) => withText('Opened the incident: ', a.title),
  set_objective: (a) => withText('Set the objective: ', a.objective),
  delegate: (a) => {
    const role = str(a.role) as AgentRole;
    return `→ briefed ${role ? roleName(role) : 'a specialist'}`;
  },
  request_decision: (a, r) => {
    const n = arr(a.options).length;
    if (str(r.label)) return withText('Asked for a decision — chosen: ', r.label);
    return n ? `Asked a person to choose between ${n} options` : 'Asked a person for a decision';
  },
  report: (a) => {
    const n = arr(a.openIssues).length;
    return `Finished — ${n === 0 ? 'no open issues' : plural(n, 'open issue')}`;
  },

  // ---------------------------------------------------------------- maintenance
  get_aircraft_status: (a, r) => {
    const t = tail(a.tail) || tail(obj(r.aircraft).tail);
    const status = str(obj(r.aircraft).status);
    return status
      ? `Checked ${t || 'the aircraft'}: ${words(status)}`
      : `Checked the status of ${t || 'the aircraft'}`;
  },
  get_open_defects: (a, r) => {
    const n = num(r.count) ?? (Array.isArray(r.defects) ? r.defects.length : undefined);
    const base = `Checked open defects${on(tail(a.tail))}`;
    return n === undefined ? base : `${base} — ${n === 0 ? 'none' : `${n} found`}`;
  },
  search_mel: search('Searched the MEL'),
  create_work_order: (a) => {
    const task = TASK_LABEL[str(a.task)] ?? (str(a.task) ? words(str(a.task)).toLowerCase() : '');
    const suffix = on(tail(a.tail));
    return task ? withText('Raised a work order: ', task, suffix) : `Raised a work order${suffix}`;
  },
  page_engineer: (a, r, ctx) => {
    const eta = num(r.etaMinute);
    const mins =
      eta !== undefined && ctx.minute !== undefined ? Math.max(0, Math.round(eta - ctx.minute)) : eta;
    const where = station(a.station);
    return `Paged the duty engineer${at(where)}${mins !== undefined ? ` — ETA ${mins} min` : ''}`;
  },
  draft_techlog_entry: (a) => `Drafted a tech log entry${forX(tail(a.tail))}`,
  record_engineering_decision: (a, r) => {
    const d = DECISION_LABEL[str(a.decision)] ?? words(str(a.decision));
    const verb = done(r) ? 'Recorded' : 'Proposed recording';
    return d ? `${verb} the decision: ${d}${forX(tail(a.tail))}` : `${verb} the engineering decision`;
  },
  defer_defect: tried(() => 'defer a defect under the MEL'),
  release_aircraft: tried((a) => `release ${tail(a.tail) || 'the aircraft'} to service`),

  // ---------------------------------------------------------------- ground
  get_stand_status: (a, r) => {
    const where = station(a.station) || station(r.station);
    const stands = arr(r.stands).map(obj);
    const free = stands.filter((s) => s.free === true).length;
    const base = `Checked the stands${at(where)}`;
    return stands.length ? `${base} — ${free} free` : base;
  },
  request_stand: (a) => {
    const s = stand(a.standId);
    return `Requested ${s ? `stand ${s}` : 'a stand'}${forX(tail(a.tail))}`;
  },
  request_tow: (a) => {
    const s = stand(a.toStandId) || stand(a.standId);
    return `Requested a tow${forX(tail(a.tail))}${s ? ` to stand ${s}` : ''}`;
  },
  request_bus: (a, r) => {
    const n = arr(r.buses).length || num(a.count) || 1;
    return `Requested ${plural(n, 'bus', 'buses')}${at(station(a.station))}`;
  },
  notify_handler: (a) => {
    const what = HANDLER_TASK_LABEL[str(a.kind)] ?? (str(a.kind) ? words(str(a.kind)) : 'a task');
    return withText('Asked the ground handler for ', what, at(station(a.station)));
  },
  search_procedure: search('Looked up the procedure'),
  get_weather: (a, r) => `Checked the weather${at(station(a.station) || station(r.station))}`,

  // ---------------------------------------------------------------- flight ops
  get_rotation: (a, r) => {
    const n = arr(r.flights).length;
    const t = tail(a.tail) || tail(r.tail);
    return `Checked the day's flights${forX(t)}${n ? ` — ${plural(n, 'flight')}` : ''}`;
  },
  find_spare_aircraft: (a, r) => {
    const candidates = arr(r.candidates).map(obj);
    const found = candidates.find((c) => c.feasible !== false && tail(c.tail));
    const where = station(a.station) || station(a.near) || station(found?.station);
    const base = `Looked for a spare aircraft${where ? at(where) : forX(flight(a.flight))}`;
    if (!done(r)) return base;
    return `${base} — ${found ? `found ${tail(found.tail) || 'one'}` : 'none available'}`;
  },
  get_crew_fdp: (a) => `Checked crew duty time${forX(flight(a.flight))}`,
  find_standby_crew: (a, r) => {
    const n = num(r.feasibleCount);
    const base = `Looked for standby crew${forX(flight(a.flight))}`;
    return n === undefined ? base : `${base} — ${n === 0 ? 'none available' : `${n} available`}`;
  },
  propose_swap: (a, r) => {
    const from = tail(a.fromTail);
    const to = tail(a.toTail);
    const n = arr(a.flights).length;
    const verb = done(r) ? 'Requested swapping' : 'Proposed swapping';
    const pair = from && to ? ` ${from} for ${to}` : ' the aircraft';
    return `${verb}${pair}${n ? ` on ${plural(n, 'flight')}` : ''}`;
  },
  propose_cancel: (a, r) =>
    `${done(r) ? 'Cancelled' : 'Proposed cancelling'} ${flight(a.flight) || 'a flight'}`,
  assign_standby_crew: (a, r) => {
    const name = str(obj(r.assigned).name);
    const f = flight(a.flight);
    if (name) return withText('Assigned ', name, ` to ${f || 'the flight'}`);
    return `Proposed standby crew${forX(f)}`;
  },
  extend_crew_fdp: tried((a) => {
    const m = num(a.minutes);
    return `extend a crew duty period${m !== undefined ? ` by ${m} min` : ''}`;
  }),

  // ---------------------------------------------------------------- passengers
  get_manifest_summary: (a, r) => {
    const total = num(r.totalPassengers);
    return `Checked the passengers${on(flight(a.flight))}${total !== undefined ? ` — ${total} booked` : ''}`;
  },
  estimate_eu261_exposure: (_a, r) => {
    const total = num(r.totalEur);
    return `Estimated compensation exposure${total !== undefined ? ` — ${eur(total)}` : ''}`;
  },
  search_passenger_rights: search('Looked up passenger rights'),
  draft_passenger_message: (a) =>
    `Drafted a passenger message${str(a.channel) ? ` (${str(a.channel)})` : ''}`,
  send_passenger_message: (a, r) => {
    const ch = str(a.channel) ? ` (${str(a.channel)})` : '';
    const who = arr(a.cohortIds).length ? ` to ${groups(a.cohortIds)}` : '';
    return done(r) ? `Sent a passenger message${ch}${who}` : `Proposed a passenger message${ch}${who}`;
  },
  issue_care_vouchers: (a, r) => {
    const kind = str(a.kind) ? `${words(str(a.kind))} vouchers` : 'care vouchers';
    const total = num(r.totalEur);
    if (done(r)) return `Issued ${kind}${total !== undefined ? ` — ${eur(total)}` : ''}`;
    return `Proposed ${kind} for ${groups(a.cohortIds)}`;
  },
  rebook_cohort: (a, r) => {
    const kind = str(obj(r.cohort).kind);
    const to = flight(a.toFlight);
    const who = kind ? `${words(kind)} passengers` : 'a passenger group';
    return `${done(r) ? 'Rebooked' : 'Proposed rebooking'} ${who}${to ? ` onto ${to}` : ''}`;
  },

  // ---------------------------------------------------------------- record
  append_timeline: (a) => withText('Logged to the incident record: ', a.text),
  draft_occurrence_report: () => 'Drafted the occurrence report (for a person to file)',
  draft_discretion_report: () => "Drafted the commander's discretion report",
  export_evidence_pack: (_a, r) => {
    const n = num(obj(r.counts).timeline);
    return `Exported the evidence pack${n !== undefined ? ` (${plural(n, 'timeline entry', 'timeline entries')})` : ''}`;
  },

  // ---------------------------------------------------------------- airborne
  get_flight_position: (a, r) => {
    const f = flight(a.flight) || flight(r.flight);
    const phase = str(r.phase);
    return `Checked where ${f || 'the flight'} is${phase ? ` — ${words(phase)}` : ''}`;
  },
  rank_diversion_airports: (a, r) => {
    const options = arr(r.options).map(obj);
    const first = station(options[0]?.iata);
    const base = `Ranked ${options.length ? `${options.length} ` : ''}diversion airports${forX(flight(a.flight))}`;
    return first ? `${base} — ${first} first` : base;
  },
  prepare_diversion_handling: (a, r) => {
    const what = listLabels(arr(a.services), SERVICE_LABEL);
    const where = at(station(a.station));
    if (done(r)) return withText('Booked ', what || 'diversion handling', where);
    return withText('Proposed ', what || 'diversion handling', where);
  },
  arrange_arrival_services: (a, r) => {
    const what = listLabels(arr(a.services), SERVICE_LABEL) || 'arrival services';
    const where = at(station(a.station));
    return withText(done(r) ? 'Arranged ' : 'Proposed ', what, where);
  },
  notify_destination_station: (a) => {
    const s = station(a.station);
    const f = flight(a.flight);
    return `Told ${s || 'the arrival station'} about ${f || 'the flight'}`;
  },
  plan_overweight_landing_inspection: (a) => `Planned an overweight-landing inspection${forX(tail(a.tail))}`,
  instruct_flight_crew: tried((a) => `instruct the crew of ${flight(a.flight) || 'the flight'}`),
  select_diversion_airport: tried((a) => {
    const s = station(a.airport);
    return `choose the diversion airport${s ? ` (${s})` : ''}`;
  }),
  approve_overweight_landing: tried((a) => `approve an overweight landing${forX(flight(a.flight))}`),

  // ---------------------------------------------------------------- scenario author
  validate_scenario: (_a, r) => {
    if (r.valid === true) return 'Checked the scenario — valid';
    const n = arr(r.errors).length;
    return n ? `Checked the scenario — ${plural(n, 'problem')}` : 'Checked the scenario';
  },
  lookup_airport: (a) => withText('Looked up the airport: ', a.query),
  search_precedents: search('Searched past incidents'),
  web_search: search('Searched the web'),
  propose_scenario_patch: () => 'Proposed changes to the scenario',
};

/**
 * The headline of one action. `result` is the tool result's data (`agent.tool_result.result`, or its parsed
 * `resultPreview`); omit it while the call is in flight or awaiting approval.
 */
export function headline(tool: string, args?: unknown, result?: unknown, ctx: HeadlineContext = {}): string {
  const template = HEADLINE_TEMPLATES[tool];
  const r = ctx.failed ? {} : obj(result);
  const text = template
    ? template(obj(args), r, ctx)
    : TOOL_LABEL[tool]
      ? `Called: ${toolLabel(tool)}`
      : 'Used a tool';
  return fitHeadline(text);
}
