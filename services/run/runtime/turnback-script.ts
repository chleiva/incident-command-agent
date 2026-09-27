/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * A deterministic scripted conversation for the airborne turnback scenario (s11, task 07): the orchestrator states
 * the commander's authority and delegates; flight ops follows the aircraft and ranks airports as options only;
 * ground asks for fire cover at the airport the commander chose; maintenance pages an engineer and plans the
 * overweight-landing inspection; passenger services proposes the first message; record drafts the occurrence report.
 * No agent instructs the flight deck. Used to record the mock-mode airborne recording (no network, £0).
 */
import { call, scriptByAgent, step, type ScriptFn } from '../llm/scripted';

const report = (summary: string, extra: Record<string, unknown> = {}) => ({
  summary,
  actionsTaken: [],
  openIssues: [],
  recommendations: [],
  citations: [],
  ...extra,
});

const COHORTS = ['c131-general', 'c131-families', 'c131-prm', 'c131-premium'];

export function turnbackScript(): ScriptFn {
  return scriptByAgent({
    orchestrator: [
      step(
        'ACX131 is in the air with a bird strike. The commander flies and decides the aircraft; our job is the ground.',
        call(
          'open_incident',
          {
            title: 'ACX131 bird strike on the climb, turnback',
            summary:
              'Engine 2 vibration after a bird strike; PAN declared; the commander decides the flight.',
            severity: 'high',
          },
          'tu_open',
        ),
        call(
          'set_objective',
          {
            objective:
              "Support the commander's decision: be ready on the ground where the aircraft lands, keep passengers informed",
            targetMinute: 30,
          },
          'tu_obj',
        ),
      ),
      step(
        'The work is independent, so I delegate in parallel. Nobody instructs the crew or chooses the airport.',
        call(
          'delegate',
          {
            role: 'flightops',
            brief:
              "Follow ACX131, rank airports as options for the commander's consideration only, and tell the planned destination.",
          },
          'tu_del_fo',
        ),
        call(
          'delegate',
          {
            role: 'ground',
            brief: 'Once the commander’s airport is known, request fire and rescue standby there.',
          },
          'tu_del_gr',
        ),
        call(
          'delegate',
          {
            role: 'maintenance',
            brief:
              'Get a B1 to meet the aircraft and plan the overweight-landing and bird-strike inspection.',
          },
          'tu_del_mx',
        ),
        call(
          'delegate',
          { role: 'passenger', brief: 'First message to passengers of ACX131 as soon as they land.' },
          'tu_del_px',
        ),
        call(
          'delegate',
          { role: 'record', brief: 'Open the timeline and draft the occurrence report.' },
          'tu_del_rc',
        ),
      ),
      step(
        'The aircraft is back on the ground at Manchester. How to recover 163 passengers is a real choice: the duty manager decides.',
        call(
          'request_decision',
          {
            question: 'How do we recover the ACX131 passengers?',
            recommendedOptionId: 'spare',
            options: [
              {
                id: 'spare',
                label: 'Re-operate to Palma on the spare AX-SPC',
                metrics: {
                  timeToDepartureMin: 75,
                  costEur: 14000,
                  customerImpact: 35,
                  compliant: true,
                  constraints: ['spare free from minute 30', 'crew duty to be checked'],
                },
                recommended: true,
              },
              {
                id: 'rebook',
                label: 'Rebook on later flights',
                metrics: {
                  timeToDepartureMin: 300,
                  costEur: 22000,
                  customerImpact: 60,
                  compliant: true,
                  constraints: ['seats limited on later flights'],
                },
                recommended: false,
              },
              {
                id: 'cancel',
                label: 'Cancel ACX131 and offer refunds and care',
                metrics: {
                  timeToDepartureMin: 0,
                  costEur: 38000,
                  customerImpact: 85,
                  compliant: true,
                  constraints: ['EU261 compensation likely'],
                },
                recommended: false,
              },
            ],
            unresolvedChecks: ['Crew duty time for a re-operation', 'Bird-strike inspection outcome'],
          },
          'tu_decide',
        ),
      ),
      step(
        'The ground is ready and the commander decided the flight. I report.',
        call(
          'report',
          report(
            'ACX131 returned to Manchester by the commander’s decision; fire cover, engineer and passenger updates were prepared on the ground.',
            {
              actionsTaken: [
                'opened the incident',
                'delegated flight ops, ground, maintenance, passenger and record',
              ],
              openIssues: ['certifying staff to decide after the overweight-landing inspection'],
              recommendations: [
                'Protect the afternoon Dublin return with the spare if the aircraft stays out of service',
              ],
            },
          ),
          'tu_report',
        ),
      ),
    ],
    flightops: [
      step(
        'Where is the aircraft and what has the commander decided?',
        call('get_flight_position', {}, 'tu_fo_pos'),
      ),
      step(
        "Options for the commander's consideration only, and the planned destination needs to know.",
        call('rank_diversion_airports', {}, 'tu_fo_rank'),
        call(
          'notify_destination_station',
          { station: 'PMI', flight: 'ACX131', requestId: 'b7a5c0de-0000-4000-8000-000000000131' },
          'tu_fo_notify',
        ),
      ),
      step(
        'Reporting.',
        call(
          'report',
          report(
            "ACX131 is returning to Manchester (the commander's decision). Ranked airports were prepared as options only; Palma informed.",
            { actionsTaken: ['followed ACX131', 'ranked airports as options', 'notified PMI'] },
          ),
          'tu_fo_report',
        ),
      ),
    ],
    ground: [
      step('I check the flight before asking for services.', call('get_flight_position', {}, 'tu_gr_pos')),
      step(
        'Fire and rescue standby at Manchester, where the commander is landing.',
        call(
          'arrange_arrival_services',
          {
            station: 'MAN',
            services: ['fire_standby'],
            tail: 'AX-TBR',
            requestId: 'b7a5c0de-0000-4000-8000-000000000231',
          },
          'tu_gr_fire',
        ),
      ),
      step(
        'Reporting.',
        call(
          'report',
          report('Fire and rescue standby requested at Manchester for the arrival of AX-TBR.', {
            actionsTaken: ['requested fire standby at MAN'],
          }),
          'tu_gr_report',
        ),
      ),
    ],
    maintenance: [
      step(
        'A B1 to meet the aircraft.',
        call(
          'page_engineer',
          { engineerId: 'eng-man-b1a', station: 'MAN', requestId: 'b7a5c0de-0000-4000-8000-000000000331' },
          'tu_mx_page',
        ),
      ),
      step(
        'The overweight landing needs an inspection; certifying staff decide after it.',
        call(
          'plan_overweight_landing_inspection',
          {
            tail: 'AX-TBR',
            station: 'MAN',
            engineerId: 'eng-man-b1a',
            requestId: 'b7a5c0de-0000-4000-8000-000000000332',
          },
          'tu_mx_owl',
        ),
      ),
      step(
        'Reporting.',
        call(
          'report',
          report(
            'Engineer paged to meet AX-TBR; overweight-landing inspection planned for certifying staff.',
            {
              actionsTaken: ['paged eng-man-b1a', 'planned the overweight-landing inspection'],
            },
          ),
          'tu_mx_report',
        ),
      ),
    ],
    passenger: [
      step('Who is on board?', call('get_manifest_summary', { flight: 'ACX131' }, 'tu_px_manifest')),
      step(
        'A first, plain message for when they land.',
        call(
          'send_passenger_message',
          {
            cohortIds: COHORTS,
            channel: 'sms',
            body: 'ACX131 to Palma is returning to Manchester after a bird strike. Staff will meet you at the gate; we will update you by 08:15.',
            requestId: 'b7a5c0de-0000-4000-8000-000000000431',
          },
          'tu_px_msg',
        ),
      ),
      step(
        'Reporting.',
        call(
          'report',
          report('First message proposed for all passengers of ACX131.', {
            actionsTaken: ['proposed the first message'],
          }),
          'tu_px_report',
        ),
      ),
    ],
    record: [
      step(
        'Timeline first.',
        call(
          'append_timeline',
          { text: 'Bird strike on the climb; PAN; the commander returns to Manchester (human decision).' },
          'tu_rc_tl',
        ),
      ),
      step(
        'Draft for a human reporter.',
        call(
          'draft_occurrence_report',
          {
            body: 'Bird strike on the climb out of Manchester on ACX131 (AX-TBR); engine 2 vibration; PAN declared; the commander returned to Manchester for an overweight landing. Draft for the named reporter.',
          },
          'tu_rc_mor',
        ),
      ),
      step(
        'Reporting.',
        call(
          'report',
          report('Timeline opened and occurrence report drafted for a human reporter.', {
            actionsTaken: ['timeline entry', 'occurrence report draft'],
          }),
          'tu_rc_report',
        ),
      ),
    ],
  });
}
