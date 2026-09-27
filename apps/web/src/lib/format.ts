/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** Formatting helpers (UK English, € for KPIs, UTC scenario clock). */
import type { Actor, AgentRole } from '@ica/schema/browser';

const eur0 = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
const int = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });

export const formatEur = (n: number) => eur0.format(Math.round(n));
export const formatInt = (n: number) => int.format(Math.round(n));

/** Compact euro: €13.3k, €1.2m. */
export function formatEurCompact(n: number): string {
  const a = Math.abs(n);
  const sign = n < 0 ? '−' : '';
  if (a >= 1_000_000) return `${sign}€${(a / 1_000_000).toFixed(1)}m`;
  if (a >= 10_000) return `${sign}€${Math.round(a / 1000)}k`;
  if (a >= 1_000) return `${sign}€${(a / 1000).toFixed(1)}k`;
  return `${sign}€${Math.round(a)}`;
}

/** Signed delta with a true minus sign. */
export function signed(n: number, fmt: (x: number) => string = formatInt): string {
  if (Math.round(n) === 0) return `±${fmt(0)}`;
  return `${n > 0 ? '+' : '−'}${fmt(Math.abs(n))}`;
}

/** 95 → "1 h 35", 42 → "42 min". */
export function formatDuration(min: number): string {
  const m = Math.round(Math.abs(min));
  const sign = min < 0 ? '−' : '';
  if (m < 60) return `${sign}${m} min`;
  return `${sign}${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
}

/** Clock-style "0:42" / "1:05" for the incident clock. */
export function formatClockDuration(min: number): string {
  const m = Math.max(0, Math.floor(min));
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
}

/** "06:52" (UTC) from an ISO time. */
export function formatUtc(iso: string | null | undefined): string {
  if (!iso) return '--:--';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '--:--';
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

/** Scenario clock at a sim minute, given the run's start time (ISO). */
export function simClockAt(startIso: string | null, minute: number): string {
  if (!startIso) return `T+${Math.round(minute)}`;
  return formatUtc(new Date(Date.parse(startIso) + minute * 60_000).toISOString());
}

export const ROLE_LABEL: Record<AgentRole, string> = {
  orchestrator: 'Orchestrator',
  maintenance: 'Maintenance',
  ground: 'Ground',
  flightops: 'Flight ops',
  passenger: 'Passenger',
  record: 'Record',
  author: 'Author',
};

export const ROLE_INITIALS: Record<AgentRole, string> = {
  orchestrator: 'OR',
  maintenance: 'MX',
  ground: 'GR',
  flightops: 'FO',
  passenger: 'PX',
  record: 'RC',
  author: 'AU',
};

export function actorLabel(a: Actor | undefined | null): string {
  if (!a) return 'Unknown';
  switch (a.kind) {
    case 'agent':
      return `${ROLE_LABEL[a.role]} agent`;
    case 'human':
      return `${a.name} · ${a.roleTitle}`;
    case 'policy':
      return a.policy === 'baseline'
        ? 'Baseline policy'
        : a.policy === 'simulation-auto'
          ? SIMULATION_AUTO_LABEL
          : 'Eval auto-approver';
    default:
      return 'World';
  }
}

/** How a simulation auto-approval reads everywhere a decision is shown (never as the user). */
export const SIMULATION_AUTO_LABEL = 'Auto-approved (simulation)';

export function isSimulationAuto(a: Actor | undefined | null): boolean {
  return a?.kind === 'policy' && a.policy === 'simulation-auto';
}

/**
 * "Approved by Sam Okafor · Duty Manager", "Rejected by …", or just "Auto-approved (simulation)" for the
 * simulation policy (which only ever approves).
 */
export function decisionPhrase(a: Actor | undefined | null, verb = 'Approved'): string {
  if (isSimulationAuto(a)) return verb === 'Approved' ? SIMULATION_AUTO_LABEL : SIMULATION_NOT_DECIDED_LABEL;
  return `${verb} by ${actorLabel(a)}`;
}

/** A certifying-staff decision the simulation closed without approving it (nobody decided in time). */
export const SIMULATION_NOT_DECIDED_LABEL = 'Not decided: certifying staff only (simulation)';

/** "send_passenger_message" → "Send passenger message". */
export function humaniseTool(tool: string): string {
  const s = tool.replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export const plural = (n: number, one: string, many = `${one}s`) => `${formatInt(n)} ${n === 1 ? one : many}`;
