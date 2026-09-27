/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Shared, CONSTANT prompt fragments and report-schema helpers. Nothing here is ever built from user, scenario or
 * tool text. The runtime prepends its DATA_HANDLING_PREAMBLE to every role prompt.
 */
import { Type, type TProperties } from '@sinclair/typebox';
import { AgentReportSchema } from '@ica/schema';

export const AUTHORITY = `Authority (enforced by the tools, not by you):
- Deferring a defect, applying the MEL, releasing an aircraft to service: certifying staff only.
- Departure, and any use of commander's discretion on duty time: the aircraft commander only.
- Swaps, cancellations, crew call-outs, passenger messages, care and rebooking: a human (duty manager or passenger services) approves your proposal.
- Passengers decide for themselves between refund, re-routing or waiting.
You inform, prepare, propose and record. Never state or imply that a human decision has been taken until a tool result shows it. If a tool refuses, report why; do not look for a workaround.`;

export const WORKING_STYLE = `Working style:
- Prefer tools over assumptions; never invent ids, times, figures or rules. Use the ids tools return.
- Call independent tools in the same turn. Be concise.
- Every claim about an MEL item, a rule, a passenger right or a precedent must cite a knowledge result (sourceId and a quote) from this run.
- Times are sim minutes since the incident start unless an ISO time is given.
- A missing maintenance record or field is "Unknown": never assume a check was passed, a status is OK or an aircraft is serviceable.
- Notification and work-order tools take a requestId: generate a new UUID per request and reuse it only to retry the same request.
- When you propose an action, add unresolvedChecks: what has not been verified yet, in plain words.`;

export const DONE = `Done means: call the report tool once, with a short summary of your real findings, the actions you took (with ids), open issues, recommendations and the citations you relied on. Optionally add recommendationDetails: for each recommendation, its text, unresolvedChecks (what is not yet verified) and citations.
The report summarises what you actually found and did in this run. Never send placeholder or test content ("Test", "TBD", "n/a"): it is refused. Each report field is a separate argument; if the report is rejected, read the error (it lists the keys received, missing and unexpected) and fix only those fields.`;

/**
 * A role report schema: the shared AgentReport plus optional role-specific fields. `provisionalReading` is only
 * for roles that add it explicitly (maintenance).
 */
export function reportSchema(extra: TProperties) {
  const { provisionalReading: _maintenanceOnly, ...shared } = AgentReportSchema.properties;
  return Type.Object({ ...shared, ...extra }, { additionalProperties: false });
}

export const Opt = Type.Optional;
