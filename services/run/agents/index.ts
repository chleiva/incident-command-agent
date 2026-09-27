/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Agent role registry (one file per role). System prompts are constant strings: NEVER interpolated with user or
 * scenario text. The runtime prepends its DATA_HANDLING_PREAMBLE and adds the runtime tools (report for everyone;
 * open_incident, delegate, set_objective, request_decision for the orchestrator).
 */
import type { AgentRole, RoleDefinition } from '@ica/schema';
import { author } from './author';
import { flightops } from './flightops';
import { ground } from './ground';
import { maintenance } from './maintenance';
import { orchestrator } from './orchestrator';
import { passenger } from './passenger';
import { record } from './record';

export const roles: Record<AgentRole, RoleDefinition> = {
  orchestrator,
  maintenance,
  ground,
  flightops,
  passenger,
  record,
  author,
};
