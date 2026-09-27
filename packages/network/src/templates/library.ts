/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** The shipped public scenarios used as templates (static JSON imports; browser-safe, no validator). */
import type { Scenario } from '@ica/schema/browser';
import { scenarioModules } from '@ica/scenarios/templates';

export const TEMPLATE_SCENARIOS: readonly Scenario[] = scenarioModules as Scenario[];

export function templateScenario(id: string): Scenario | undefined {
  return TEMPLATE_SCENARIOS.find((s) => s.id === id);
}
