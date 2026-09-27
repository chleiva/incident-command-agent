/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * A deterministic scripted conversation that exercises the runtime end to end using ONLY runtime tools (so it runs
 * against any registry): open the incident, set the objective, delegate to two specialists concurrently, ask for a
 * human decision with ranked options, attempt a forbidden deferral, then report. Used by `run:local --provider
 * scripted` and to record the replay-tier CI fixture.
 */
import type { LlmRequest } from '@ica/schema';
import { call, scriptByAgent, step, type ScriptFn } from '../llm/scripted';

const emptyReport = (summary: string, extra: Record<string, unknown> = {}) => ({
  summary,
  actionsTaken: [],
  openIssues: [],
  recommendations: [],
  citations: [],
  ...extra,
});

export function demoScript(): ScriptFn {
  return scriptByAgent({
    orchestrator: [
      step(
        'A door-sensor caution is reported before departure. I will open the incident and set the objective.',
        call(
          'open_incident',
          {
            title: 'Cargo door caution before departure',
            summary: 'Intermittent door caution; aircraft on stand; passengers boarding.',
            severity: 'medium',
          },
          'tu_open',
        ),
        call(
          'set_objective',
          { objective: 'Establish airworthiness and keep passengers informed', targetMinute: 45 },
          'tu_obj',
        ),
      ),
      step(
        'Maintenance and passenger work are independent, so I delegate both in parallel.',
        call(
          'delegate',
          { role: 'maintenance', brief: 'Assess the door caution and get an engineer to the aircraft.' },
          'tu_del_mx',
        ),
        call(
          'delegate',
          { role: 'passenger', brief: 'Prepare an early, plain-language update for all cohorts.' },
          'tu_del_pax',
        ),
      ),
      step(
        'Deferral would be fastest but it is not mine to decide; I try it only to confirm the guardrail.',
        call('defer_defect', { defectId: 'd-1', melItem: '52-00' }, 'tu_defer'),
      ),
      step(
        'There are real alternatives, so the duty manager decides.',
        call(
          'request_decision',
          {
            question: 'Rectify on stand or swap to the spare aircraft?',
            recommendedOptionId: 'rectify',
            options: [
              {
                id: 'rectify',
                label: 'Rectify on stand',
                metrics: {
                  timeToDepartureMin: 50,
                  costEur: 5000,
                  customerImpact: 30,
                  compliant: true,
                  constraints: [],
                },
                recommended: true,
              },
              {
                id: 'swap',
                label: 'Swap to spare',
                metrics: {
                  timeToDepartureMin: 70,
                  costEur: 9000,
                  customerImpact: 45,
                  compliant: true,
                  constraints: ['spare free at minute 45'],
                },
                recommended: false,
              },
            ],
          },
          'tu_decide',
        ),
      ),
      step(
        'The decision is recorded; I report.',
        call(
          'report',
          emptyReport('Incident coordinated; the duty manager chose the option on record.', {
            actionsTaken: ['opened incident', 'delegated maintenance and passenger', 'requested a decision'],
            openIssues: ['certifying engineer to confirm rectification'],
          }),
          'tu_report',
        ),
      ),
    ],
    maintenance: [
      step(
        'I will report what I found.',
        call('report', emptyReport('Engineer requested; certifying staff decide.'), 'tu_mx_report'),
      ),
    ],
    passenger: [
      step(
        'Passengers informed plan ready.',
        call('report', emptyReport('First update drafted for all cohorts.'), 'tu_pax_report'),
      ),
    ],
  });
}

/** True when a request is the demo's orchestrator (for quick assertions). */
export function isOrchestrator(req: LlmRequest): boolean {
  return req.meta?.role === 'orchestrator';
}
