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
  description: `Propose the patch that makes the template scenario match the duty manager's description. Every field is optional; omit what the description does not change. Limits: narrative ≤ ${SCENARIO_PATCH_LIMITS.narrative} characters, ≤ ${SCENARIO_PATCH_LIMITS.evidence} evidence items, ≤ ${SCENARIO_PATCH_LIMITS.twists} extra twists with 1-${SCENARIO_PATCH_LIMITS.effectsPerTwist} effects each, cohort changes for existing cohort ids only. Reference only flights, tails, stations and entity ids that are in the template. Returns accepted, or the errors to fix.`,
  inputSchema: JSON.parse(JSON.stringify(ScenarioPatchSchema)) as JSONSchema,
};
