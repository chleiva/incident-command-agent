/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * The domain registries the runtime consumes (task 03 owns their contents). Consumed ONLY through the exported names
 * `domainTools`, `systems`/`seedAll` and `roles`, so the real registries replace the test doubles without code
 * changes. Tests inject their own `Registry`.
 */
import type {
  AgentRole,
  MockSystem,
  RoleDefinition,
  Scenario,
  SystemState,
  ToolDefinition,
} from '@ica/schema';
import { roles } from '../agents/index';
import { seedAll, systems } from '../systems/index';
import { domainTools } from '../tools/index';

export interface Registry {
  tools: ToolDefinition[];
  systems: MockSystem<any>[];
  seedAll: (scenario: Scenario, rng: () => number) => SystemState;
  roles: Record<AgentRole, RoleDefinition>;
}

export function defaultRegistry(): Registry {
  return { tools: domainTools, systems, seedAll, roles };
}
