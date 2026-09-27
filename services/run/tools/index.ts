/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Domain tool registry (one module per tool). Task 02 consumes `domainTools` and adds its own runtime tools
 * (open_incident, delegate, set_objective, request_decision, report). Tiers follow the autonomy matrix in
 * docs/tasks/03-domain-systems-tools-knowledge.md §3 exactly; `registry.test.ts` pins them.
 */
import type { ToolDefinition } from '@ica/schema';
import { append_timeline } from './append_timeline';
import { assign_standby_crew } from './assign_standby_crew';
import { create_work_order } from './create_work_order';
import { defer_defect } from './defer_defect';
import { draft_discretion_report } from './draft_discretion_report';
import { draft_occurrence_report } from './draft_occurrence_report';
import { draft_passenger_message } from './draft_passenger_message';
import { draft_techlog_entry } from './draft_techlog_entry';
import { estimate_eu261_exposure } from './estimate_eu261_exposure';
import { export_evidence_pack } from './export_evidence_pack';
import { extend_crew_fdp } from './extend_crew_fdp';
import { find_spare_aircraft } from './find_spare_aircraft';
import { find_standby_crew } from './find_standby_crew';
import { get_aircraft_status } from './get_aircraft_status';
import { get_crew_fdp } from './get_crew_fdp';
import { get_manifest_summary } from './get_manifest_summary';
import { get_open_defects } from './get_open_defects';
import { get_rotation } from './get_rotation';
import { get_stand_status } from './get_stand_status';
import { get_weather } from './get_weather';
import { issue_care_vouchers } from './issue_care_vouchers';
import { lookup_airport } from './lookup_airport';
import { notify_handler } from './notify_handler';
import { page_engineer } from './page_engineer';
import { propose_cancel } from './propose_cancel';
import { propose_swap } from './propose_swap';
import { rebook_cohort } from './rebook_cohort';
import { record_engineering_decision } from './record_engineering_decision';
import { release_aircraft } from './release_aircraft';
import { request_bus } from './request_bus';
import { request_stand } from './request_stand';
import { request_tow } from './request_tow';
import { search_mel } from './search_mel';
import { search_passenger_rights } from './search_passenger_rights';
import { search_precedents } from './search_precedents';
import { search_procedure } from './search_procedure';
import { send_passenger_message } from './send_passenger_message';
import { validate_scenario } from './validate_scenario';
import { web_search } from './web_search';
import { get_flight_position } from './get_flight_position';
import { rank_diversion_airports } from './rank_diversion_airports';
import { prepare_diversion_handling } from './prepare_diversion_handling';
import { arrange_arrival_services } from './arrange_arrival_services';
import { notify_destination_station } from './notify_destination_station';
import { plan_overweight_landing_inspection } from './plan_overweight_landing_inspection';
import { instruct_flight_crew } from './instruct_flight_crew';
import { select_diversion_airport } from './select_diversion_airport';
import { approve_overweight_landing } from './approve_overweight_landing';

export const domainTools: ToolDefinition[] = [
  // maintenance
  get_aircraft_status,
  get_open_defects,
  search_mel,
  create_work_order,
  page_engineer,
  draft_techlog_entry,
  record_engineering_decision,
  defer_defect,
  release_aircraft,
  // ground (+ maintenance for the shared knowledge/weather tools)
  get_stand_status,
  request_stand,
  request_tow,
  request_bus,
  notify_handler,
  search_procedure,
  get_weather,
  // flight ops
  get_rotation,
  find_spare_aircraft,
  get_crew_fdp,
  find_standby_crew,
  propose_swap,
  propose_cancel,
  assign_standby_crew,
  extend_crew_fdp,
  // passenger
  get_manifest_summary,
  estimate_eu261_exposure,
  search_passenger_rights,
  draft_passenger_message,
  send_passenger_message,
  issue_care_vouchers,
  rebook_cohort,
  // record
  append_timeline,
  draft_occurrence_report,
  draft_discretion_report,
  export_evidence_pack,
  // airborne incidents (task 07): ground-side coordination only; flight-deck decisions are forbidden
  get_flight_position,
  rank_diversion_airports,
  prepare_diversion_handling,
  arrange_arrival_services,
  notify_destination_station,
  plan_overweight_landing_inspection,
  instruct_flight_crew,
  select_diversion_airport,
  approve_overweight_landing,
  // author
  validate_scenario,
  lookup_airport,
  search_precedents,
  web_search,
];

export const toolByName: Record<string, ToolDefinition> = Object.fromEntries(
  domainTools.map((t) => [t.name, t]),
);
