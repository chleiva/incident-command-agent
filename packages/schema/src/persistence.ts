/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Persistence interfaces. Defined here (dependency-free) so `runtime.ts` can reference them without a package
 * cycle; `@ica/store` re-exports them and provides the implementations. Import them from `@ica/store`.
 */
import type { AuthorDraft, RunMeta, ScenarioSummary, EvalReport } from './api';
import type { ApprovalRecord, ApprovalStatus, EventDraft, RunEvent } from './events';
import type { StateSystemName } from './ids';
import type { SystemMutation } from './runtime';
import type { Scenario } from './scenario';
import type { SystemState } from './systems';

export interface EventPage {
  events: RunEvent[];
  lastSeq: number;
  hasMore: boolean;
}

/** The mutable part of an ApprovalRecord (see `Store.decideApproval`). */
export type ApprovalPatch = Partial<Pick<ApprovalRecord, 'status' | 'decision' | 'expiresAtMinute'>>;

export interface Store {
  // scenarios (private/authored; public ones come from @ica/scenarios)
  putScenario(s: Scenario): Promise<void>;
  getScenario(id: string): Promise<Scenario | null>;
  listScenarios(): Promise<ScenarioSummary[]>;

  // runs
  createRun(meta: RunMeta): Promise<void>;
  getRun(runId: string): Promise<RunMeta | null>;
  /** `lastSeq` in the patch is ignored: only `append` moves it. */
  updateRun(runId: string, patch: Partial<RunMeta>): Promise<void>;
  /** Newest first. */
  listRuns(limit: number): Promise<RunMeta[]>;
  /** Runs whose `createdAt >= isoTime` (MAX_RUNS_PER_DAY). */
  countRunsSince(isoTime: string): Promise<number>;

  /**
   * The single write path for events + mock state. Atomically assigns gap-free seqs (lastSeq+1…), writes the
   * events and applies `mutations` (SYS# rows), and advances RunMeta.lastSeq/simMinute. Returns the stored events.
   * The caller includes one `system.mutation` draft per mutation (see `mutationDraft`). Throws RunNotFoundError
   * if the run does not exist.
   */
  append(runId: string, drafts: EventDraft[], mutations?: SystemMutation[]): Promise<RunEvent[]>;
  /** Events with seq > afterSeq, ascending, up to `limit` (default 500). `lastSeq` = the run's current lastSeq. */
  listEvents(runId: string, afterSeq: number, limit?: number): Promise<EventPage>;

  // approvals
  putApproval(a: ApprovalRecord): Promise<void>;
  getApproval(runId: string, approvalId: string): Promise<ApprovalRecord | null>;
  listApprovals(runId: string, status?: ApprovalStatus): Promise<ApprovalRecord[]>;
  /**
   * Addition (integration): conditional update. Merges `patch` into the approval only if its current status is
   * `expectedStatus` (atomically: DynamoDB ConditionExpression on `status`). Returns false, changing nothing, when the
   * approval is missing or in another status, so two simultaneous decisions cannot both be accepted. A key set to
   * `undefined` in the patch is removed.
   */
  decideApproval(
    runId: string,
    approvalId: string,
    expectedStatus: ApprovalStatus,
    patch: ApprovalPatch,
  ): Promise<boolean>;

  /**
   * Addition (self-recovery): claim resume attempt `attempt` of a run, atomically: sets `RunMeta.resumeAttempt`
   * only when it is absent or lower, so exactly one invocation resumes each attempt (Lambda may deliver an async
   * event twice). Returns false when the attempt was already claimed. Optional: a store without it never resumes.
   */
  claimResume?(runId: string, attempt: number): Promise<boolean>;

  // mock state (current, as persisted by append)
  getSystemState(runId: string, system?: StateSystemName): Promise<Partial<SystemState>>;

  // websocket connections
  putConnection(connectionId: string, runId: string): Promise<void>;
  deleteConnection(connectionId: string): Promise<void>;
  listConnections(runId: string): Promise<string[]>;

  // evals
  /** Addition (async authoring): Training "write a scenario" drafts (`DRAFT#{id}/META`, TTL 1 day). */
  putAuthorDraft(d: AuthorDraft): Promise<void>;
  getAuthorDraft(draftId: string): Promise<AuthorDraft | null>;

  putEvalReport(r: EvalReport): Promise<void>;
  getLatestEvalReport(): Promise<EvalReport | null>;
}

/** Local stand-in for DynamoDB Streams. `MemoryStore.append` publishes to it. */
export interface EventBus {
  /** Returns an unsubscribe function. Events arrive in seq order, per append batch. */
  subscribe(runId: string, onEvents: (events: RunEvent[]) => void): () => void;
  publish(runId: string, events: RunEvent[]): void;
}

export interface TracePutOptions {
  /** Appended to the seq in the key: `traces/{runId}/{seq}{suffix}.json`, e.g. '.payload' or '.llm'. */
  suffix?: string;
}

export interface TraceStore {
  /**
   * Store a trace body; returns its key `traces/{runId}/{seq}{suffix}.json`. `seq` may be a string label
   * (e.g. `${agentRunId}-${iteration}`) when the event seq is not yet known.
   */
  put(runId: string, seq: number | string, body: unknown, opts?: TracePutOptions): Promise<string>;
  get(key: string): Promise<unknown>;
  /**
   * Addition (audit logs): every object under `traces/{runId}/` (LLM call traces, oversized payloads, exports), in
   * key order. Optional: stores that cannot list return no LLM entries in the audit.
   */
  list?(runId: string): Promise<TraceObjectInfo[]>;
}

/** One stored trace object (audit logs). */
export interface TraceObjectInfo {
  key: string;
  /** Bytes, when the store knows it. */
  size?: number;
  /** ISO time the object was written, when the store knows it. */
  lastModified?: string;
}

export interface SecretStore {
  get(name: string): Promise<string | undefined>;
}

export class RunNotFoundError extends Error {
  constructor(public readonly runId: string) {
    super(`run not found: ${runId}`);
    this.name = 'RunNotFoundError';
  }
}
