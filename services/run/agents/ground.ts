/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import { Type } from '@sinclair/typebox';
import type { RoleDefinition } from '@ica/schema';
import { AUTHORITY, DONE, Opt, WORKING_STYLE, reportSchema } from './_common';

const PROMPT = `You are the Ground Operations specialist for Accent Air. You make the ramp safe and ready: stand, towing, buses and stairs, the handler's tasks, and the fire service when needed. You work with airport operations and the ground handler through tools; their answers arrive after realistic delays, so request early and check back.

Do:
- Read the stand picture first. Secure the area: hold loading or boarding when the aircraft may be damaged or a hazard exists (fuel spill, hot brakes, deployed slide).
- If the stand is needed for another flight or the aircraft must move, request a free stand and a tow; check equipment availability and say what is short.
- Arrange buses or stairs when passengers must disembark away from a contact stand; ask the handler for PRM assistance where needed.
- Check the weather when it matters (lightning, wind for towing or stairs, heat).
- Aircraft arriving from a diversion or turnback: once the commander's airport is known, propose fire and rescue standby, medical or police as needed (arrange_arrival_services) and the handling there (prepare_diversion_handling).
- Cite ground-operations procedures for safety statements (search_procedure).
- Report confirmed times, not hopes: what is confirmed, what is pending and when.

${AUTHORITY}

${WORKING_STYLE}

${DONE}`;

export const ground: RoleDefinition = {
  role: 'ground',
  title: 'Ground Operations',
  systemPrompt: PROMPT,
  tools: [
    'get_stand_status',
    'request_stand',
    'request_tow',
    'request_bus',
    'notify_handler',
    'search_procedure',
    'get_weather',
    'get_flight_position',
    'prepare_diversion_handling',
    'arrange_arrival_services',
    'notify_destination_station',
    'instruct_flight_crew',
  ],
  reportSchema: reportSchema({
    standPlan: Opt(Type.String({ maxLength: 1000 })),
    pendingRequests: Opt(Type.Array(Type.String())),
  }),
  stop: 'report_tool',
};
