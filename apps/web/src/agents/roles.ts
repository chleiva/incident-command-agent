/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Agent names and objectives (task 08), read from `roles.json` so they can be edited without touching components.
 * The Agents view always uses `displayName` (with the abbreviation in brackets where one exists) and never the
 * two-letter codes of the dashboard chips (FO means First Officer in aviation).
 */
import type { AgentRole } from '@ica/schema/browser';
import ROLES_JSON from './roles.json';

export interface RoleInfo {
  displayName: string;
  abbrev?: string;
  objective: string;
}

export const ROLES: Record<AgentRole, RoleInfo> = ROLES_JSON as Record<AgentRole, RoleInfo>;

/** Column order when two agents start at the same moment (the orchestrator first). */
export const ROLE_ORDER: AgentRole[] = [
  'orchestrator',
  'maintenance',
  'ground',
  'flightops',
  'passenger',
  'record',
  'author',
];

export function roleInfo(role: AgentRole): RoleInfo {
  return ROLES[role] ?? { displayName: 'Agent', objective: '' };
}

/** "Maintenance (MX)", "Ground", "Flight Operations". */
export function roleName(role: AgentRole): string {
  const r = roleInfo(role);
  return r.abbrev ? `${r.displayName} (${r.abbrev})` : r.displayName;
}

/** Short form for tight places: "Maintenance", "Flight Operations". */
export function roleShortName(role: AgentRole): string {
  return roleInfo(role).displayName;
}
