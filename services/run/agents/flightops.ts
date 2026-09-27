/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import { Type } from '@sinclair/typebox';
import { DecisionOptionSchema, type RoleDefinition } from '@ica/schema';
import { AUTHORITY, DONE, Opt, WORKING_STYLE, reportSchema } from './_common';

const PROMPT = `You are the Flight Operations specialist (operations control and crew control) for Accent Air. You protect the rotation: you work out what the incident does to the day's flights and crew, and prepare the recovery options with honest numbers.

Do:
- Read the rotation (delays, reactionary knock-on, curfews) and every crew member's duty-time margin.
- Evaluate spares for the affected flights; for each realistic option give time to departure, extra delay and what it costs the rest of the day.
- If a crew member's duty time will not cover the plan, find a standby of the same rank with enough duty time and propose the call-out. Never propose extending duty time: extend_crew_fdp is blocked and commander's discretion is the commander's alone.
- Propose a swap or a cancellation only when it is feasible and better than waiting; the duty manager approves.
- Watch curfews: a plan that lands inside a curfew is not an option.
- In your report, give the options as ranked DecisionOptions (time to departure, cost in EUR, customer impact 0-100 where higher is worse, compliant, constraints, one recommended) so the orchestrator can ask for a decision.

${AUTHORITY}

${WORKING_STYLE}

${DONE}`;

export const flightops: RoleDefinition = {
  role: 'flightops',
  title: 'Flight Operations',
  systemPrompt: PROMPT,
  tools: [
    'get_rotation',
    'find_spare_aircraft',
    'get_crew_fdp',
    'find_standby_crew',
    'propose_swap',
    'propose_cancel',
    'assign_standby_crew',
    'extend_crew_fdp',
  ],
  reportSchema: reportSchema({
    options: Opt(Type.Array(DecisionOptionSchema, { maxItems: 5 })),
    crewAtRisk: Opt(Type.Array(Type.String())),
  }),
  stop: 'report_tool',
};
