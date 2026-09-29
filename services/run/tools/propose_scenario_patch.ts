/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * `propose_scenario_patch`: the only tool of the Scenario Author in patch mode (async authoring, run-side). The model
 * proposes a compact, schema-bounded patch on the flight's template scenario; the authoring loop
 * (runtime/authoring.ts) validates it (schema, references, merged scenario) and answers with the errors or accepts
 * it. Not part of the domain registry: it acts on no system and no agent role but the Author calls it.
 */
import { SCENARIO_PATCH_LIMITS, ScenarioPatchSchema, type JSONSchema, type LlmToolSpec } from '@ica/schema';

export const PROPOSE_SCENARIO_PATCH = 'propose_scenario_patch';

export const propose_scenario_patch: LlmToolSpec = {
  name: PROPOSE_SCENARIO_PATCH,
  description: `Propose the patch that makes the scenario match the duty manager's description (the description's facts win). Every field is optional; omit what is not needed. replaceNarrative / replaceTrigger rewrite the narrative and trigger; removeTwistIds removes contradicting template twists; commanderDecision relays the incident flight commander's decision (airborne only); network lists up to ${SCENARIO_PATCH_LIMITS.networkFlights} flights from the network slice with their effect (hold, delay, cancel, divert, monitor). Limits: narrative ≤ ${SCENARIO_PATCH_LIMITS.narrative} characters, ≤ ${SCENARIO_PATCH_LIMITS.evidence} evidence items, ≤ ${SCENARIO_PATCH_LIMITS.twists} extra twists for a typed incident (≤ ${SCENARIO_PATCH_LIMITS.twistsOther} for something else) with 1-${SCENARIO_PATCH_LIMITS.effectsPerTwist} effects each, cohort changes for existing cohort ids only. Reference only flights, tails, stations and entity ids that are in the scenario or the network slice. Returns accepted, or the errors to fix.`,
  inputSchema: JSON.parse(JSON.stringify(ScenarioPatchSchema)) as JSONSchema,
};
