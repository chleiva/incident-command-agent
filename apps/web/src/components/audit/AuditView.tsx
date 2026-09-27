/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** The Audit page body: header note, run picker slot, filters, export and the audit table (four states). */
import type { AgentRole, AuditEntryKind } from '@ica/schema/browser';
import { useMemo, useState, type ReactNode } from 'react';
import { NO_FILTERS, filterEntries, rolesIn, type AuditFilters, type AuditRun } from '../../audit/audit';
import { roleName } from '../../agents/roles';
import { Icon } from '../ui/Icon';
import { Badge, Button, StateFrame, type LoadStatus } from '../ui/primitives';
import type { TraceLoader } from './AuditEntryDetail';
import { AuditTable } from './AuditTable';

export const AUDIT_NOTE =
  'Full audit of what was sent to and returned by the model and tools. API keys are redacted.';

export interface AuditViewProps {
  run: AuditRun | null;
  status: LoadStatus;
  error?: string | null;
  loadTrace: TraceLoader;
  onRetry?: () => void;
  onExport?: () => void;
  exportProgress?: { done: number; total: number } | null;
  /** The run picker (a select of recent runs). */
  picker?: ReactNode;
  virtualize?: boolean;
  /** Rows open initially (stories). */
  initialExpanded?: string[];
}

const control =
  'h-7 rounded-md border border-border-control/60 bg-surface px-2 text-caption text-fg focus-visible:border-focus';

export function AuditView({
  run,
  status,
  error,
  loadTrace,
  onRetry,
  onExport,
  exportProgress,
  picker,
  virtualize,
  initialExpanded,
}: AuditViewProps) {
  const [filters, setFilters] = useState<AuditFilters>(NO_FILTERS);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(initialExpanded));
  const entries = run?.entries ?? [];
  const roles = useMemo(() => rolesIn(entries), [entries]);
  const shown = useMemo(() => filterEntries(entries, filters), [entries, filters]);
  const llmCount = entries.filter((e) => e.kind === 'llm').length;
  const toggle = (id: string) =>
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const exporting = !!exportProgress && exportProgress.done < exportProgress.total;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3" data-testid="audit-view">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="text-heading text-fg">Audit</h1>
          <p className="flex items-center gap-1 text-caption text-fg-muted" data-testid="audit-note">
            <Icon name="shield" size={12} /> {AUDIT_NOTE}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {picker}
          {onExport && (
            <Button
              size="sm"
              onClick={onExport}
              disabled={!run || exporting || !entries.length}
              aria-describedby={exportProgress ? 'audit-export-progress' : undefined}
            >
              <Icon name="download" size={12} /> Export run audit (.jsonl)
            </Button>
          )}
          {exportProgress && (
            <span
              id="audit-export-progress"
              className="flex items-center gap-2 text-caption text-fg-muted"
              role="status"
            >
              <progress
                value={exportProgress.done}
                max={Math.max(1, exportProgress.total)}
                className="h-2 w-24"
                aria-label="Export progress"
              />
              {exporting
                ? `Exporting ${exportProgress.done}/${exportProgress.total}…`
                : `Exported ${exportProgress.total} entries`}
            </span>
          )}
        </div>
      </div>

      {run && (
        <div
          className="flex flex-wrap items-center gap-2 text-caption text-fg-muted"
          data-testid="audit-run-header"
        >
          <span className="text-body font-medium text-fg">{run.runName}</span>
          <Badge>{run.mode}</Badge>
          <Badge tone={run.status === 'failed' ? 'critical' : 'neutral'}>{run.status}</Badge>
          <span>
            {entries.length} entries · {llmCount} model calls · {entries.length - llmCount} tool calls
          </span>
          {!run.tracesListed && (
            <Badge
              tone="warning"
              title="The trace store could not be listed; calls without an event are missing."
            >
              trace listing unavailable
            </Badge>
          )}
        </div>
      )}

      <form
        className="flex flex-wrap items-end gap-2"
        role="search"
        aria-label="Filter the audit"
        onSubmit={(e) => e.preventDefault()}
      >
        <label className="flex flex-col gap-0.5 text-micro text-fg-muted">
          Agent
          <select
            className={control}
            value={filters.role}
            onChange={(e) => setFilters({ ...filters, role: e.target.value as AgentRole | 'all' })}
          >
            <option value="all">All agents</option>
            {roles.map((r) => (
              <option key={r} value={r}>
                {roleName(r)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-0.5 text-micro text-fg-muted">
          Kind
          <select
            className={control}
            value={filters.kind}
            onChange={(e) => setFilters({ ...filters, kind: e.target.value as AuditEntryKind | 'all' })}
          >
            <option value="all">LLM and tool calls</option>
            <option value="llm">LLM calls</option>
            <option value="tool">Tool calls</option>
          </select>
        </label>
        <label className="flex min-w-[16rem] flex-1 flex-col gap-0.5 text-micro text-fg-muted">
          Search tool names, arguments and results
          <input
            type="search"
            className={control}
            value={filters.query}
            placeholder="e.g. ACX123, send_passenger_message"
            onChange={(e) => setFilters({ ...filters, query: e.target.value })}
          />
        </label>
        <span className="pb-1 text-caption text-fg-muted" aria-live="polite">
          Showing {shown.length} of {entries.length}
        </span>
      </form>

      <h2 className="sr-only">Entries</h2>
      <div className="flex min-h-0 flex-1 flex-col">
        <StateFrame
          status={status}
          error={error}
          onRetry={onRetry}
          empty={status === 'ready' && (!run || shown.length === 0)}
          emptyText={
            !run
              ? 'Pick a run to see its audit.'
              : entries.length
                ? 'No entries match these filters.'
                : 'No model or tool calls were recorded for this run.'
          }
        >
          {run && (
            <AuditTable
              entries={shown}
              runName={run.runName}
              startSimTime={run.startSimTime}
              expanded={expanded}
              onToggle={toggle}
              loadTrace={loadTrace}
              virtualize={virtualize}
            />
          )}
        </StateFrame>
      </div>
    </div>
  );
}
