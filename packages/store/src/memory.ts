/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** In-memory Store + EventBus for local dev (`npm run dev`), tests and the headless runner. */
import {
  RunNotFoundError,
  summariseScenario,
  validateEvent,
  type ApprovalPatch,
  type ApprovalRecord,
  type ApprovalStatus,
  type EvalReport,
  type EventBus,
  type EventDraft,
  type EventPage,
  type RunEvent,
  type RunMeta,
  type Scenario,
  type ScenarioSummary,
  type StateSystemName,
  type Store,
  type SystemMutation,
  type SystemState,
} from '@ica/schema';
import { clone, emptyStateFor, toEvent } from './util';

export class MemoryEventBus implements EventBus {
  private subs = new Map<string, Set<(events: RunEvent[]) => void>>();

  subscribe(runId: string, onEvents: (events: RunEvent[]) => void): () => void {
    let set = this.subs.get(runId);
    if (!set) this.subs.set(runId, (set = new Set()));
    set.add(onEvents);
    return () => {
      set.delete(onEvents);
      if (set.size === 0) this.subs.delete(runId);
    };
  }

  publish(runId: string, events: RunEvent[]): void {
    for (const cb of [...(this.subs.get(runId) ?? [])]) {
      try {
        cb(clone(events));
      } catch (err) {
        console.error(JSON.stringify({ msg: 'event bus subscriber failed', runId, err: String(err) }));
      }
    }
  }
}

export interface MemoryStoreOptions {
  bus?: EventBus;
  /** Validate every appended event against the schema (default true: catches contract drift early). */
  validateEvents?: boolean;
  now?: () => string;
}

type Loose = Record<string, Record<string, Record<string, unknown>>>;

export interface MemoryStoreSnapshot {
  version: 1;
  scenarios: Scenario[];
  runs: RunMeta[];
  events: Record<string, RunEvent[]>;
  approvals: ApprovalRecord[];
  state: Record<string, Loose>;
  connections: Record<string, string>;
  evals: EvalReport[];
}

export class MemoryStore implements Store {
  private scenarios = new Map<string, Scenario>();
  private runs = new Map<string, RunMeta>();
  private events = new Map<string, RunEvent[]>();
  private approvals = new Map<string, Map<string, ApprovalRecord>>();
  private state = new Map<string, Loose>();
  private connections = new Map<string, string>();
  private evals: EvalReport[] = [];
  readonly bus?: EventBus;
  private readonly validate: boolean;
  private readonly now: () => string;

  constructor(opts: MemoryStoreOptions = {}) {
    this.bus = opts.bus;
    this.validate = opts.validateEvents ?? true;
    this.now = opts.now ?? (() => new Date().toISOString());
  }

  // ------------------------------------------------------------------ scenarios
  async putScenario(s: Scenario): Promise<void> {
    this.scenarios.set(s.id, clone(s));
  }
  async getScenario(id: string): Promise<Scenario | null> {
    return clone(this.scenarios.get(id) ?? null);
  }
  async listScenarios(): Promise<ScenarioSummary[]> {
    return [...this.scenarios.values()].sort((a, b) => a.id.localeCompare(b.id)).map(summariseScenario);
  }

  // ------------------------------------------------------------------ runs
  async createRun(meta: RunMeta): Promise<void> {
    if (this.runs.has(meta.runId)) throw new Error(`run already exists: ${meta.runId}`);
    this.runs.set(meta.runId, clone({ ...meta, lastSeq: 0 }));
    this.events.set(meta.runId, []);
  }
  async getRun(runId: string): Promise<RunMeta | null> {
    return clone(this.runs.get(runId) ?? null);
  }
  async updateRun(runId: string, patch: Partial<RunMeta>): Promise<void> {
    const cur = this.runs.get(runId);
    if (!cur) throw new RunNotFoundError(runId);
    const { lastSeq: _ignored, runId: _id, ...rest } = patch;
    this.runs.set(runId, clone({ ...cur, ...rest, updatedAt: rest.updatedAt ?? this.now() }));
  }
  async listRuns(limit: number): Promise<RunMeta[]> {
    return [...this.runs.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.runId.localeCompare(a.runId))
      .slice(0, limit)
      .map(clone);
  }
  async countRunsSince(isoTime: string): Promise<number> {
    return [...this.runs.values()].filter((r) => r.createdAt >= isoTime).length;
  }

  // ------------------------------------------------------------------ events
  async append(runId: string, drafts: EventDraft[], mutations: SystemMutation[] = []): Promise<RunEvent[]> {
    const meta = this.runs.get(runId);
    if (!meta) throw new RunNotFoundError(runId);
    if (!drafts.length && !mutations.length) return [];
    const log = this.events.get(runId)!;
    const start = meta.lastSeq;
    const created = drafts.map((d, i) => toEvent(runId, start + i + 1, d, this.now));
    if (this.validate) {
      for (const e of created) {
        const r = validateEvent(e);
        if (!r.ok) throw new Error(`invalid event ${e.type}: ${r.errors.join('; ')}`);
      }
    }
    // commit (synchronous: atomic with respect to other appends)
    const st = this.state.get(runId) ?? {};
    for (const m of mutations) {
      const sys = (st[m.system] ??= {});
      const ent = (sys[m.entity] ??= {});
      if (m.op === 'delete') delete ent[m.id];
      else ent[m.id] = clone(m.after ?? {});
    }
    this.state.set(runId, st);
    log.push(...created);
    const last = created.at(-1);
    this.runs.set(runId, {
      ...meta,
      lastSeq: start + created.length,
      simMinute: last ? Math.max(meta.simMinute, last.simMinute) : meta.simMinute,
    });
    if (created.length) this.bus?.publish(runId, created);
    return clone(created);
  }

  async listEvents(runId: string, afterSeq: number, limit = 500): Promise<EventPage> {
    const log = this.events.get(runId) ?? [];
    const lastSeq = this.runs.get(runId)?.lastSeq ?? 0;
    const rest = log.filter((e) => e.seq > afterSeq);
    return { events: clone(rest.slice(0, limit)), lastSeq, hasMore: rest.length > limit };
  }

  // ------------------------------------------------------------------ approvals
  async putApproval(a: ApprovalRecord): Promise<void> {
    let m = this.approvals.get(a.runId);
    if (!m) this.approvals.set(a.runId, (m = new Map()));
    m.set(a.approvalId, clone(a));
  }
  async getApproval(runId: string, approvalId: string): Promise<ApprovalRecord | null> {
    return clone(this.approvals.get(runId)?.get(approvalId) ?? null);
  }
  async decideApproval(
    runId: string,
    approvalId: string,
    expectedStatus: ApprovalStatus,
    patch: ApprovalPatch,
  ): Promise<boolean> {
    // Check-and-set without an await in between: atomic on the event loop.
    const cur = this.approvals.get(runId)?.get(approvalId);
    if (!cur || cur.status !== expectedStatus) return false;
    const next = { ...cur, ...clone(patch) } as Record<string, unknown>;
    for (const [k, v] of Object.entries(patch)) if (v === undefined) delete next[k];
    this.approvals.get(runId)!.set(approvalId, next as ApprovalRecord);
    return true;
  }
  async listApprovals(runId: string, status?: ApprovalStatus): Promise<ApprovalRecord[]> {
    return [...(this.approvals.get(runId)?.values() ?? [])]
      .filter((a) => !status || a.status === status)
      .sort((a, b) => a.proposalSeq - b.proposalSeq)
      .map(clone);
  }

  // ------------------------------------------------------------------ mock state
  async getSystemState(runId: string, system?: StateSystemName): Promise<Partial<SystemState>> {
    const out = emptyStateFor(system);
    const st = this.state.get(runId) ?? {};
    for (const [sys, entities] of Object.entries(st)) {
      if (system && sys !== system) continue;
      out[sys] ??= {};
      for (const [entity, rows] of Object.entries(entities)) out[sys][entity] = clone(rows);
    }
    return out as unknown as Partial<SystemState>;
  }

  // ------------------------------------------------------------------ connections
  async putConnection(connectionId: string, runId: string): Promise<void> {
    this.connections.set(connectionId, runId);
  }
  async deleteConnection(connectionId: string): Promise<void> {
    this.connections.delete(connectionId);
  }
  async listConnections(runId: string): Promise<string[]> {
    return [...this.connections.entries()]
      .filter(([, r]) => r === runId)
      .map(([c]) => c)
      .sort();
  }

  // ------------------------------------------------------------------ evals
  async putEvalReport(r: EvalReport): Promise<void> {
    this.evals = this.evals.filter((x) => x.id !== r.id);
    this.evals.push(clone(r));
  }
  async getLatestEvalReport(): Promise<EvalReport | null> {
    const sorted = [...this.evals].sort(
      (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
    );
    return clone(sorted[0] ?? null);
  }

  // ------------------------------------------------------------------ persistence across restarts (LOCAL_PERSIST)
  snapshot(): MemoryStoreSnapshot {
    return clone({
      version: 1,
      scenarios: [...this.scenarios.values()],
      runs: [...this.runs.values()],
      events: Object.fromEntries(this.events),
      approvals: [...this.approvals.values()].flatMap((m) => [...m.values()]),
      state: Object.fromEntries(this.state),
      connections: Object.fromEntries(this.connections),
      evals: this.evals,
    });
  }

  static fromSnapshot(snap: MemoryStoreSnapshot, opts: MemoryStoreOptions = {}): MemoryStore {
    const s = new MemoryStore(opts);
    const c = clone(snap);
    for (const x of c.scenarios) s.scenarios.set(x.id, x);
    for (const r of c.runs) s.runs.set(r.runId, r);
    for (const [k, v] of Object.entries(c.events)) s.events.set(k, v);
    for (const a of c.approvals) void s.putApproval(a);
    for (const [k, v] of Object.entries(c.state)) s.state.set(k, v);
    for (const [k, v] of Object.entries(c.connections)) s.connections.set(k, v);
    s.evals = c.evals;
    return s;
  }
}
