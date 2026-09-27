/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * @ica/scenarios — the shipped public scenarios (CC BY 4.0), loaded through static JSON imports generated into
 * public/index.gen.ts by `npm run scenarios:validate` (import.meta.glob is not available in Node).
 * Private scenarios live in scenarios/private/ (git-ignored) and reach a deployment via `npm run scenarios:push`.
 */
import { SCENARIO_IDS, type Scenario } from '@ica/schema';
import { scenarioModules } from './public/index.gen';

export const publicScenarios: Scenario[] = scenarioModules as Scenario[];

export function getPublicScenario(id: string): Scenario | undefined {
  return publicScenarios.find((s) => s.id === id);
}

export { SCENARIO_IDS };
