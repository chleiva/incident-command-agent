/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** The expanded audit row: the full LLM trace (fetched on open) or the tool call's raw input and output. */
import type { AuditLlmEntry, AuditToolEntry, AuditEntry } from '@ica/schema/browser';
import { useEffect, useState } from 'react';
import { formatBytes, type LoadedTrace } from '../../audit/audit';
import { actorLabel } from '../../lib/format';
import { Button, Skeleton, TierBadge } from '../ui/primitives';
import { JsonViewer } from './JsonViewer';
import { LlmTraceView } from './LlmTraceView';

export type TraceLoader = (key: string) => Promise<LoadedTrace>;

export function AuditEntryDetail({ entry, loadTrace }: { entry: AuditEntry; loadTrace: TraceLoader }) {
  return entry.kind === 'llm' ? (
    <LlmDetail entry={entry} loadTrace={loadTrace} />
  ) : (
    <ToolDetail entry={entry} />
  );
}

/** "ar-maintenance-1-i003" from `traces/{runId}/ar-maintenance-1-i003.json`. */
function stemOf(key: string): string {
  return (key.split('/').pop() ?? 'trace').replace(/\.json$/, '');
}

function LlmDetail({ entry, loadTrace }: { entry: AuditLlmEntry; loadTrace: TraceLoader }) {
  const [state, setState] = useState<
    { status: 'loading' } | { status: 'error'; error: string } | { status: 'ready'; trace: LoadedTrace }
  >({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setState({ status: 'loading' });
    loadTrace(entry.traceKey).then(
      (trace) => live && setState({ status: 'ready', trace }),
      (e: unknown) =>
        live && setState({ status: 'error', error: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      live = false;
    };
  }, [entry.traceKey, loadTrace, attempt]);

  if (state.status === 'loading')
    return (
      <div role="status" aria-label="Loading the model call" className="flex flex-col gap-2">
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  if (state.status === 'error')
    return (
      <div role="alert" className="flex items-center gap-2 text-body text-critical">
        Couldn’t load this model call: {state.error}
        <Button size="sm" onClick={() => setAttempt(attempt + 1)}>
          Retry
        </Button>
      </div>
    );
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <p className="text-caption text-fg-muted">
        Stored trace <span className="font-mono">{entry.traceKey}</span> ·{' '}
        {formatBytes(state.trace.sizeBytes)}
      </p>
      <LlmTraceView trace={state.trace.trace} stem={stemOf(entry.traceKey)} />
    </div>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return <li className="text-caption text-fg-muted">{children}</li>;
}

function ToolDetail({ entry }: { entry: AuditToolEntry }) {
  const stem = `${entry.tool}-${entry.toolCallId}`.replace(/[^A-Za-z0-9._-]+/g, '_');
  const output =
    entry.ok === false
      ? {
          ok: false,
          error: entry.error ?? entry.resultPreview,
          ...(entry.result !== undefined ? { result: entry.result } : {}),
        }
      : entry.result !== undefined
        ? entry.result
        : entry.resultPreview;
  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid="tool-detail">
      <ul className="flex flex-col gap-1">
        <li className="flex flex-wrap items-center gap-2 text-caption text-fg-muted">
          {entry.tier ? <TierBadge tier={entry.tier} /> : null}
          <span className="font-mono text-fg">{entry.tool}</span>
          {entry.system && <span>system: {entry.system}</span>}
          <span className="font-mono">{entry.toolCallId}</span>
          {entry.latencyMs !== undefined && <span>{entry.latencyMs} ms</span>}
        </li>
        {entry.normalisedFrom && (
          <Note>
            Normalised: the model called “{entry.normalisedFrom}”, run as “{entry.tool}”.
          </Note>
        )}
        {entry.argsRepaired?.length ? (
          <Note>Arguments repaired from leaked markup: {entry.argsRepaired.join(', ')}.</Note>
        ) : null}
        {entry.argsTruncated?.length ? (
          <Note>Arguments truncated at their length cap: {entry.argsTruncated.join(', ')}.</Note>
        ) : null}
        {entry.deduplicatedFrom && (
          <Note>Idempotent retry: the result of {entry.deduplicatedFrom} was returned.</Note>
        )}
        {entry.presenterTriggered && <Note>Triggered by the presenter (“Demonstrate blocked action”).</Note>}
        {entry.blocked && (
          <Note>
            Blocked by the {entry.blocked.layer} guardrail: {entry.blocked.reason}
            {entry.blocked.rule ? ` (${entry.blocked.rule})` : ''}
            {entry.blocked.authority ? ` — authority: ${entry.blocked.authority}` : ''}.
          </Note>
        )}
        {entry.proposal && (
          <Note>
            Proposed for approval ({entry.proposal.approvalId}): {entry.proposal.summary}
          </Note>
        )}
        {entry.decision && (
          <Note>
            Decision: {entry.decision.decision} by {actorLabel(entry.decision.decidedBy)} at m
            {Math.round(entry.decision.simMinute)}
            {entry.decision.reason ? ` — “${entry.decision.reason}”` : ''}
            {entry.decision.editedArgs ? ' (arguments edited)' : ''}
          </Note>
        )}
      </ul>
      <div className="grid min-w-0 gap-3 xl:grid-cols-2">
        <section
          aria-label="Input"
          className="flex min-w-0 flex-col gap-1 rounded-md border border-border bg-surface p-2"
        >
          <h3 className="text-body font-semibold text-fg">Input</h3>
          <JsonViewer
            value={entry.args ?? null}
            label="Tool input JSON"
            filename={`${stem}.input.json`}
            testId="tool-input"
          />
          {entry.decision?.editedArgs && (
            <>
              <h4 className="text-caption font-semibold text-fg">Arguments as edited by the approver</h4>
              <JsonViewer
                value={entry.decision.editedArgs}
                label="Edited arguments JSON"
                filename={`${stem}.edited.json`}
              />
            </>
          )}
        </section>
        <section
          aria-label="Output"
          className="flex min-w-0 flex-col gap-1 rounded-md border border-border bg-surface p-2"
        >
          <h3 className="text-body font-semibold text-fg">Output</h3>
          {entry.ok === undefined && entry.result === undefined ? (
            <p className="text-body text-fg-muted">No result recorded (in flight or awaiting a decision).</p>
          ) : (
            <JsonViewer
              value={output}
              label="Tool output JSON"
              filename={`${stem}.output.json`}
              testId="tool-output"
            />
          )}
        </section>
      </div>
    </div>
  );
}
