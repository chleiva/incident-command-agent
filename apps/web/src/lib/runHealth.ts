/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Run health, in plain words: how a run ended (completed, stopped by the presenter, aborted, or failed on a system
 * error) and whether it is recovering from a system error. Pure derivations over the projection and the event log.
 *
 * Self-recovery events are additive and optional (`run.recovering {attempt, reason}`, `run.resumed_after_error
 * {attempt}`): they are read defensively by type name, so an older backend simply never produces them. A recovery
 * is never a failure: the run goes on; only `run.failed` (or a `failed`/`error` status) is final.
 */
import type { RunEvent, RunProjection } from '@ica/schema/browser';

export const RUN_RECOVERING = 'run.recovering';
export const RUN_RESUMED_AFTER_ERROR = 'run.resumed_after_error';

/** A calm one-line reason for a technical error message (the technical text stays available, expandable). */
export function plainFailureReason(error: string | undefined | null, where?: string | null): string {
  const e = `${error ?? ''}`.toLowerCase();
  const w = `${where ?? ''}`.toLowerCase();
  if (/timed? ?out|timeout|wall[ _-]?clock|deadline|remaining time/.test(e))
    return 'the run took longer than the system allows';
  if (/throttl|rate ?limit|\b429\b|overloaded|too many requests|\b529\b/.test(e))
    return 'the AI service was too busy to answer';
  if (/conditionalcheck|transaction|conflict|seq(uence)? (gap|conflict)|provisionedthroughput/.test(e))
    return 'the event store could not record a step';
  if (/network|fetch failed|econn|socket|dns|enotfound|503|502|504|unavailable/.test(e))
    return 'a connection to a backend service dropped';
  if (/budget|token cap|tokens?/.test(e) && /exceed|limit|cap/.test(e))
    return 'a safety limit on the run was reached';
  if (/api key|unauthori[sz]ed|forbidden|credential|401|403/.test(e))
    return 'the AI service rejected the credentials';
  if (/llm|model|anthropic|openai|bedrock/.test(w) || /llm|model|anthropic|openai|bedrock/.test(e))
    return 'the AI model could not be reached';
  if (/scenario|author/.test(w)) return 'the scenario could not be prepared';
  if (/store|dynamo|stream/.test(w)) return 'the event store could not record a step';
  return 'an unexpected internal error';
}

export interface RunFailure {
  error: string;
  where: string;
  /** Plain-language reason ("the AI service was too busy to answer"). */
  plain: string;
  minute: number | null;
  seq: number | null;
}

/** The final failure of a run (`run.failed`, or a `failed`/`error` status), else null. */
export function runFailure(
  p: Pick<RunProjection, 'meta' | 'simMinute'>,
  events: readonly RunEvent[] = [],
): RunFailure | null {
  const status = p.meta.status as string;
  const failedEvent = [...events].reverse().find((e) => e.type === 'run.failed');
  if (status !== 'failed' && status !== 'error' && !failedEvent) return null;
  const payload = (failedEvent?.payload ?? {}) as { error?: unknown; where?: unknown };
  const error = String(p.meta.error?.error ?? payload.error ?? 'No error message was recorded.');
  const where = String(p.meta.error?.where ?? payload.where ?? 'run');
  return {
    error,
    where,
    plain: plainFailureReason(error, where),
    minute: failedEvent?.simMinute ?? p.simMinute ?? null,
    seq: failedEvent?.seq ?? null,
  };
}

export type RunOutcomeKind = 'active' | 'completed' | 'stopped' | 'aborted' | 'failed';

export interface RunOutcome {
  kind: RunOutcomeKind;
  /** Badge text. */
  label: string;
  tone: 'neutral' | 'good' | 'warning' | 'critical';
}

/**
 * How a run stands, from its status (projection meta or `RunMeta`) and, when known, the completion reason:
 * `completed` + `stopped` reads "stopped" (the kill switch), `aborted` reads "aborted", `failed`/`error` read
 * "failed" — never "completed".
 */
export function runOutcome(meta: { status: string; completedReason?: string | null }): RunOutcome {
  switch (meta.status) {
    case 'failed':
    case 'error':
      return { kind: 'failed', label: 'failed', tone: 'critical' };
    case 'aborted':
      return { kind: 'aborted', label: 'aborted', tone: 'warning' };
    case 'completed':
      return meta.completedReason === 'stopped'
        ? { kind: 'stopped', label: 'stopped', tone: 'warning' }
        : { kind: 'completed', label: 'completed', tone: 'good' };
    case 'stopped':
      return { kind: 'stopped', label: 'stopped', tone: 'warning' };
    default:
      return {
        kind: 'active',
        label: meta.status || 'unknown',
        tone: meta.status === 'paused' ? 'warning' : 'neutral',
      };
  }
}

export interface RecoveryEvent {
  kind: 'recovering' | 'resumed';
  seq: number;
  minute: number;
  attempt: number | null;
  reason: string | null;
}

/** The self-recovery events of a run, in order (none on a backend without self-recovery). */
export function recoveryEvents(events: readonly RunEvent[]): RecoveryEvent[] {
  const out: RecoveryEvent[] = [];
  for (const e of events) {
    const type = e.type as string;
    if (type !== RUN_RECOVERING && type !== RUN_RESUMED_AFTER_ERROR) continue;
    const p = (e.payload ?? {}) as { attempt?: unknown; reason?: unknown };
    out.push({
      kind: type === RUN_RECOVERING ? 'recovering' : 'resumed',
      seq: e.seq,
      minute: e.simMinute,
      attempt: typeof p.attempt === 'number' ? p.attempt : null,
      reason: typeof p.reason === 'string' && p.reason ? p.reason : null,
    });
  }
  return out;
}

export interface RecoveryState {
  status: 'recovering' | 'recovered';
  attempt: number | null;
  /** Technical reason of the error being recovered from. */
  reason: string | null;
  plain: string;
  /** Seq of the latest recovery event (dismissal key). */
  seq: number;
  /** Sim minute the run resumed at (recovered only). */
  resumedMinute: number | null;
}

/**
 * The latest recovery episode, or null. A final failure after it wins (the caller shows the failure instead).
 */
export function recoveryState(events: readonly RunEvent[]): RecoveryState | null {
  const all = recoveryEvents(events);
  const last = all.at(-1);
  if (!last) return null;
  const started = [...all].reverse().find((r) => r.kind === 'recovering') ?? null;
  const reason = started?.reason ?? last.reason;
  return {
    status: last.kind === 'recovering' ? 'recovering' : 'recovered',
    attempt: last.attempt ?? started?.attempt ?? null,
    reason,
    plain: plainFailureReason(reason),
    seq: last.seq,
    resumedMinute: last.kind === 'resumed' ? last.minute : null,
  };
}

export interface RunLevelEvent {
  seq: number;
  minute: number;
  kind: 'failed' | 'recovering' | 'resumed' | 'stopped' | 'agent_error';
  tone: 'critical' | 'warning' | 'neutral';
  /** Plain-language line. */
  text: string;
  /** The technical detail (expandable). */
  detail?: string;
}

/**
 * The run-level system events of a run (for the Audit view): final failure, self-recovery, a presenter stop, and
 * agents stopped by a system error. Model and tool calls are the audit entries themselves.
 */
export function runLevelEvents(events: readonly RunEvent[]): RunLevelEvent[] {
  const out: RunLevelEvent[] = [];
  for (const e of events) {
    const base = { seq: e.seq, minute: e.simMinute };
    const type = e.type as string;
    if (e.type === 'run.failed') {
      out.push({
        ...base,
        kind: 'failed',
        tone: 'critical',
        text: `Run stopped because of a system error: ${plainFailureReason(e.payload.error, e.payload.where)}`,
        detail: `${e.payload.where}: ${e.payload.error}`,
      });
    } else if (e.type === 'run.completed' && e.payload.reason === 'stopped') {
      out.push({
        ...base,
        kind: 'stopped',
        tone: 'warning',
        text: 'Run stopped by the presenter (kill switch)',
      });
    } else if (e.type === 'agent.aborted' && e.payload.reason === 'error') {
      out.push({
        ...base,
        kind: 'agent_error',
        tone: 'warning',
        text: `An agent stopped because of a system error: ${plainFailureReason(e.payload.detail)}`,
        detail: `${e.payload.role}: ${e.payload.detail}`,
      });
    } else if (type === RUN_RECOVERING || type === RUN_RESUMED_AFTER_ERROR) {
      const r = recoveryEvents([e])[0];
      if (!r) continue;
      out.push(
        r.kind === 'recovering'
          ? {
              ...base,
              kind: 'recovering',
              tone: 'warning',
              text: `System error — recovering${r.attempt !== null ? ` (attempt ${r.attempt})` : ''}: ${plainFailureReason(r.reason)}`,
              ...(r.reason ? { detail: r.reason } : {}),
            }
          : {
              ...base,
              kind: 'resumed',
              tone: 'neutral',
              text: `Recovered — resumed at m${Math.round(r.minute)}; the agents were re-briefed from the record`,
            },
      );
    }
  }
  return out;
}

/** Every event of a run, page by page (the Audit view reads the run-level system events from it). */
export async function loadAllEvents(
  listEvents: (
    runId: string,
    after: number,
  ) => Promise<{ events: RunEvent[]; lastSeq: number; hasMore: boolean }>,
  runId: string,
  maxPages = 200,
): Promise<RunEvent[]> {
  const all: RunEvent[] = [];
  let after = 0;
  for (let i = 0; i < maxPages; i++) {
    const page = await listEvents(runId, after);
    all.push(...page.events);
    const last = page.events.at(-1)?.seq ?? after;
    if (!page.hasMore || last <= after) break;
    after = last;
  }
  return all;
}
