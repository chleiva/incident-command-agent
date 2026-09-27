/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import { AGENT_ROLES, TOOL_SYSTEMS, compileSchema } from '@ica/schema';
import { domainTools } from './index';

/** The autonomy matrix (docs/tasks/03-…md §3). Final: evals and the UI rely on it. */
const MATRIX: Record<string, { tier: 'execute' | 'propose' | 'forbidden'; roles: string[] }> = {
  get_aircraft_status: { tier: 'execute', roles: ['maintenance'] },
  get_open_defects: { tier: 'execute', roles: ['maintenance'] },
  search_mel: { tier: 'execute', roles: ['maintenance'] },
  create_work_order: { tier: 'execute', roles: ['maintenance'] },
  page_engineer: { tier: 'execute', roles: ['maintenance'] },
  draft_techlog_entry: { tier: 'propose', roles: ['maintenance'] },
  record_engineering_decision: { tier: 'propose', roles: ['maintenance'] },
  defer_defect: { tier: 'forbidden', roles: ['maintenance'] },
  release_aircraft: { tier: 'forbidden', roles: ['maintenance'] },
  get_stand_status: { tier: 'execute', roles: ['ground'] },
  request_stand: { tier: 'execute', roles: ['ground'] },
  request_tow: { tier: 'execute', roles: ['ground'] },
  request_bus: { tier: 'execute', roles: ['ground'] },
  notify_handler: { tier: 'execute', roles: ['ground'] },
  search_procedure: { tier: 'execute', roles: ['ground', 'maintenance'] },
  get_weather: { tier: 'execute', roles: ['ground', 'maintenance'] },
  get_rotation: { tier: 'execute', roles: ['flightops'] },
  find_spare_aircraft: { tier: 'execute', roles: ['flightops'] },
  get_crew_fdp: { tier: 'execute', roles: ['flightops'] },
  find_standby_crew: { tier: 'execute', roles: ['flightops'] },
  propose_swap: { tier: 'propose', roles: ['flightops'] },
  propose_cancel: { tier: 'propose', roles: ['flightops'] },
  assign_standby_crew: { tier: 'propose', roles: ['flightops'] },
  extend_crew_fdp: { tier: 'forbidden', roles: ['flightops'] },
  get_manifest_summary: { tier: 'execute', roles: ['passenger'] },
  estimate_eu261_exposure: { tier: 'execute', roles: ['passenger'] },
  search_passenger_rights: { tier: 'execute', roles: ['passenger'] },
  draft_passenger_message: { tier: 'execute', roles: ['passenger'] },
  send_passenger_message: { tier: 'propose', roles: ['passenger'] },
  issue_care_vouchers: { tier: 'propose', roles: ['passenger'] },
  rebook_cohort: { tier: 'propose', roles: ['passenger'] },
  append_timeline: { tier: 'execute', roles: ['record'] },
  draft_occurrence_report: { tier: 'execute', roles: ['record'] },
  draft_discretion_report: { tier: 'execute', roles: ['record'] },
  export_evidence_pack: { tier: 'execute', roles: ['record'] },
  validate_scenario: { tier: 'execute', roles: ['author'] },
  lookup_airport: { tier: 'execute', roles: ['author'] },
  search_precedents: { tier: 'execute', roles: ['author'] },
  web_search: { tier: 'execute', roles: ['author'] },
  // task 07: airborne incidents (the commander flies and decides; the ground prepares)
  get_flight_position: { tier: 'execute', roles: ['flightops', 'ground', 'maintenance'] },
  rank_diversion_airports: { tier: 'execute', roles: ['flightops'] },
  prepare_diversion_handling: { tier: 'propose', roles: ['ground'] },
  arrange_arrival_services: { tier: 'propose', roles: ['ground'] },
  notify_destination_station: { tier: 'execute', roles: ['ground', 'flightops'] },
  plan_overweight_landing_inspection: { tier: 'execute', roles: ['maintenance'] },
  instruct_flight_crew: { tier: 'forbidden', roles: ['flightops', 'ground'] },
  select_diversion_airport: { tier: 'forbidden', roles: ['flightops'] },
  approve_overweight_landing: { tier: 'forbidden', roles: ['maintenance', 'flightops'] },
};

const RUNTIME_TOOLS = ['open_incident', 'delegate', 'set_objective', 'request_decision', 'report'];

function pointerExists(schema: any, pointer: string): boolean {
  const [, first] = pointer.split('/');
  return !!schema.properties?.[first];
}

describe('domainTools registry', () => {
  it('implements exactly the autonomy matrix, with the tiers and roles specified', () => {
    expect(domainTools.map((t) => t.name).sort()).toEqual(Object.keys(MATRIX).sort());
    for (const t of domainTools) {
      expect({ name: t.name, tier: t.tier, roles: [...t.roles].sort() }).toEqual({
        name: t.name,
        tier: MATRIX[t.name].tier,
        roles: [...MATRIX[t.name].roles].sort(),
      });
    }
  });

  it('never defines the runtime tools owned by task 02', () => {
    for (const n of RUNTIME_TOOLS) expect(domainTools.find((t) => t.name === n)).toBeUndefined();
  });

  it('human-only decisions are forbidden; people-affecting actions are propose', () => {
    const tier = (n: string) => domainTools.find((t) => t.name === n)!.tier;
    for (const n of ['defer_defect', 'release_aircraft', 'extend_crew_fdp'])
      expect(tier(n)).toBe('forbidden');
    for (const n of [
      'send_passenger_message',
      'issue_care_vouchers',
      'rebook_cohort',
      'propose_swap',
      'propose_cancel',
    ])
      expect(tier(n)).toBe('propose');
  });

  it('every input schema is strict, compiles with the shared Ajv, and declares valid refs/outputScreen pointers', () => {
    for (const t of domainTools) {
      const s = t.inputSchema as any;
      expect(s.type, t.name).toBe('object');
      expect(s.additionalProperties, t.name).toBe(false);
      expect(() => compileSchema(s)).not.toThrow();
      expect(t.description.length, t.name).toBeGreaterThan(60);
      expect(TOOL_SYSTEMS).toContain(t.system);
      for (const r of t.roles) expect(AGENT_ROLES).toContain(r);
      for (const r of t.refs ?? []) expect(pointerExists(s, r.path), `${t.name} ref ${r.path}`).toBe(true);
      for (const f of t.outputScreen?.fields ?? [])
        expect(pointerExists(s, f), `${t.name} screen ${f}`).toBe(true);
    }
  });

  it('free text only flows into mutations through output-screened fields', () => {
    for (const t of domainTools.filter((x) => x.mutates)) {
      const props = (t.inputSchema as any).properties as Record<string, any>;
      const freeText = Object.entries(props)
        .filter(([, p]) => p.type === 'string' && !p.enum && !p.pattern && (p.maxLength ?? 0) > 60)
        .map(([k]) => `/${k}`);
      for (const f of freeText) expect(t.outputScreen?.fields ?? [], `${t.name}${f}`).toContain(f);
    }
  });

  it('screened outputs are declared with the right kind', () => {
    const kind = (n: string) => domainTools.find((t) => t.name === n)!.outputScreen?.kind;
    expect(kind('draft_passenger_message')).toBe('passenger_message');
    expect(kind('send_passenger_message')).toBe('passenger_message');
    expect(kind('draft_techlog_entry')).toBe('techlog');
    for (const n of ['draft_occurrence_report', 'draft_discretion_report', 'append_timeline'])
      expect(kind(n)).toBe('report');
  });
});
