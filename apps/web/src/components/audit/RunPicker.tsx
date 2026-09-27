/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** Recent runs for the Audit page: a compact select (a run is open) and a table (no run picked yet). */
import type { RunMeta } from '@ica/schema/browser';
import { Link } from 'react-router-dom';
import { flightOf } from '../../audit/audit';
import { Badge, StateFrame, type LoadStatus } from '../ui/primitives';

export function runStarted(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 16).replace('T', ' ') + 'Z';
}

/** Flights by scenario id (from the scenarios), falling back to a flight named in the title or id. */
export type FlightLookup = Record<string, string | undefined>;

export function runOptionLabel(r: RunMeta, flights: FlightLookup = {}): string {
  const flight = flights[r.scenarioId] ?? flightOf(r);
  const title =
    flight && !r.scenarioTitle.includes(flight) ? `${r.scenarioTitle} · ${flight}` : r.scenarioTitle;
  return `${title} — ${runStarted(r.createdAt)} · ${r.mode} · ${r.status}`;
}

export function RunSelect({
  runs,
  value,
  onChange,
  flights,
}: {
  runs: RunMeta[];
  value: string;
  onChange(runId: string): void;
  flights?: FlightLookup;
}) {
  const known = runs.some((r) => r.runId === value);
  return (
    <label className="flex items-center gap-2 text-caption text-fg-muted">
      Run
      <select
        className="h-7 max-w-[32rem] rounded-md border border-border-control/60 bg-surface px-2 text-caption text-fg"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        data-testid="audit-run-select"
      >
        {!known && <option value={value}>{value || 'Pick a run'}</option>}
        {runs.map((r) => (
          <option key={r.runId} value={r.runId}>
            {runOptionLabel(r, flights)}
          </option>
        ))}
      </select>
    </label>
  );
}

export function RecentRunsTable({
  runs,
  status,
  error,
  onRetry,
  flights = {},
}: {
  runs: RunMeta[];
  status: LoadStatus;
  error?: string | null;
  onRetry?: () => void;
  flights?: FlightLookup;
}) {
  return (
    <StateFrame status={status} error={error} onRetry={onRetry} empty={!runs.length} emptyText="No runs yet.">
      <table className="w-full border-collapse text-left text-body" data-testid="audit-runs">
        <caption className="sr-only">Recent runs</caption>
        <thead>
          <tr className="border-b border-border text-micro uppercase text-fg-muted">
            <th scope="col" className="px-2 py-1 font-semibold">
              Scenario
            </th>
            <th scope="col" className="px-2 py-1 font-semibold">
              Flight
            </th>
            <th scope="col" className="px-2 py-1 font-semibold">
              Started
            </th>
            <th scope="col" className="px-2 py-1 font-semibold">
              Mode
            </th>
            <th scope="col" className="px-2 py-1 font-semibold">
              Status
            </th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.runId} className="border-b border-border hover:bg-surface-hover">
              <td className="px-2 py-1">
                <Link
                  to={`/runs/${encodeURIComponent(r.runId)}/audit`}
                  className="text-fg underline decoration-border-control underline-offset-2"
                >
                  {r.scenarioTitle}
                </Link>
              </td>
              <td className="px-2 py-1 font-mono text-caption text-fg-muted">
                {flights[r.scenarioId] ?? flightOf(r) ?? '—'}
              </td>
              <td className="px-2 py-1 text-caption text-fg-muted">{runStarted(r.createdAt)}</td>
              <td className="px-2 py-1">
                <Badge>{r.mode}</Badge>
              </td>
              <td className="px-2 py-1">
                <Badge tone={r.status === 'failed' ? 'critical' : 'neutral'}>{r.status}</Badge>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </StateFrame>
  );
}
