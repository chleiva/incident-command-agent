/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * RunContext: everything one run shares. The single write path (`append`, serialised so the local state mirror
 * stays consistent), the inbox (approval decisions, control and twist requests written by the API), budgets and
 * hard limits, the LLM router, the sim clock and the stop signal.
 */
import {
  type AGENT_ABORT_REASONS,
  type DemoForbiddenTool,
  emptySystemState,
  mutationDraft,
  type Actor,
  type ApprovalDecisionKind,
  type EventDraft,
  type EventPayloadMap,
  type EventType,
  type KnowledgeIndex,
  type KpiSnapshot,
  type LlmConfig,
  type RefKind,
  type RunDeps,
  type RunEvent,
  type RunEventBase,
  type RunLimits,
  type RunTotals,
  type Scenario,
  type SystemMutation,
  type SystemState,
  type WallClock,
  type WorldScheduled,
  draft,
} from '@ica/schema';
import { LlmRouter, costUsd, totalInputTokens, worstCaseUsd, type RoutedResponse } from '../llm/index';
import type { LlmRequest, LlmUsage } from '@ica/schema';
import type { KnownRefs } from '../guardrails/validate';
import { SimClock, realClock } from '../world/clock';
import type { Registry } from './registry';
import { IdCounter, deepClone, hash32, seededRng } from './util';

export type StopReason = 'report' | 'horizon' | 'stopped';
export type AbortReason = (typeof AGENT_ABORT_REASONS)[number];

/** Why an agent (or the whole run) stopped early. `runLevel` breaches stop every agent. */
export class AgentAbort extends Error {
  constructor(
    readonly reason: AbortReason,
    readonly detail: string,
    readonly runLevel = false,
  ) {
    super(`${reason}: ${detail}`);
    this.name = 'AgentAbort';
  }
}

export interface Decision {
  decision: ApprovalDecisionKind;
  editedArgs?: Record<string, unknown>;
  selectedOptionId?: string;
  reason?: string;
  decidedBy: Actor;
  seq: number;
}

export interface TwistNotice {
  seq: number;
  title: string;
  text: string;
}

export interface PendingTwistRequest {
  seq: number;
  twistId?: string;
  text?: string;
}

export interface RunContextOptions {
  runId: string;
  scenario: Scenario;
  deps: RunDeps;
  registry: Registry;
  speed?: number;
  /** Eval policy: tools the `eval-auto` policy rejects. */
  rejectTools?: string[];
  signal?: AbortSignal;
  log?: (line: Record<string, unknown>) => void;
}

export class RunContext {
  readonly runId: string;
  readonly scenario: Scenario;
  readonly deps: RunDeps;
  readonly registry: Registry;
  readonly clock: WallClock;
  readonly sim: SimClock;
  readonly limits: RunLimits;
  readonly llm: LlmConfig;
  readonly rng: () => number;
  readonly ids = new IdCounter();
  readonly router: LlmRouter;
  readonly abort = new AbortController();
  readonly rejectTools: string[];
  readonly startWallMs: number;
  readonly log: (line: Record<string, unknown>) => void;
  knowledge: KnowledgeIndex;
  /** Follow-ups scheduled by tools (WorldScheduled), applied by the world engine at `atMinute`. */
  readonly followUps: WorldScheduled[] = [];

  state: SystemState;
  /** Scenario narrative as agents see it (neutralised when input screening flagged it). */
  narrative: string;
  totals: RunTotals;
  private reservedUsd = 0;
  private events: RunEvent[] = [];
  private seen = new Set<number>();
  private cursor = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private waiters = new Map<string, { resolve: (d: Decision) => void; promise: Promise<Decision> }>();
  private decisions = new Map<string, Decision>();
  readonly twistFeed: TwistNotice[] = [];
  readonly twistRequests: PendingTwistRequest[] = [];
  latestKpis: KpiSnapshot | null = null;
  /** Presenter control `demo_forbidden` (agent mode): pushes a synthetic call through the real tier gate. */
  onDemoForbidden?: (tool: DemoForbiddenTool) => Promise<void>;
  /** Background work the run waits for before it finishes (revisions after `approval.invalidated`). */
  private background = new Set<Promise<unknown>>();
  finishReason: StopReason | null = null;
  abortReason: AbortReason | null = null;
  abortDetail = '';
  private unsubscribe?: () => void;
  private wake?: () => void;

  constructor(opts: RunContextOptions) {
    this.runId = opts.runId;
    this.scenario = opts.scenario;
    this.narrative = opts.scenario.narrative;
    this.deps = opts.deps;
    this.registry = opts.registry;
    this.clock = opts.deps.clock ?? realClock;
    this.llm = opts.deps.llm;
    this.limits = opts.deps.llm.limits;
    this.sim = new SimClock(opts.scenario.startSimTime, opts.speed ?? 6);
    this.rng = seededRng(hash32(opts.runId));
    this.rejectTools = opts.rejectTools ?? [];
    this.knowledge = opts.deps.knowledge;
    this.startWallMs = this.clock.now();
    this.totals = { inputTokens: 0, outputTokens: 0, costUsd: 0, toolCalls: 0, iterations: 0, wallMs: 0 };
    this.state = emptySystemState();
    this.log =
      opts.log ??
      ((line) => {
        if (process.env.ICA_LOG !== 'silent') console.log(JSON.stringify({ runId: this.runId, ...line }));
      });
    this.router = new LlmRouter({
      config: this.llm,
      deps: { secrets: opts.deps.secrets, providers: opts.deps.providers },
      clock: this.clock,
      rng: this.rng,
      onFallback: async (from, to, reason) => {
        await this.emit('llm.fallback', { from, to, reason }, { kind: 'world' });
        this.log({ msg: 'llm fallback', from, to });
      },
    });
    if (opts.signal) {
      if (opts.signal.aborted) this.stop('stopped', 'aborted before start');
      else opts.signal.addEventListener('abort', () => this.stop('stopped', 'run signal aborted'));
    }
    if (opts.deps.bus) {
      this.unsubscribe = opts.deps.bus.subscribe(this.runId, (evs) => {
        for (const e of evs) this.ingest(e);
        this.wake?.();
      });
    }
  }

  scheduleFollowUp(f: WorldScheduled): void {
    this.followUps.push(f);
  }

  /** Run `p` in the background; the run does not finish normally until it settles. */
  trackBackground(p: Promise<unknown>): void {
    const tracked = p.catch((err) => this.log({ msg: 'background work failed', err: String(err) }));
    this.background.add(tracked);
    void tracked.finally(() => this.background.delete(tracked));
  }

  /** Wait until all background work (including work it starts) has settled, or the run stops. */
  async drainBackground(): Promise<void> {
    while (this.background.size && !this.stopping) await Promise.allSettled([...this.background]);
  }

  dispose(): void {
    this.unsubscribe?.();
  }

  // ------------------------------------------------------------------ status
  get finished(): boolean {
    return this.finishReason !== null;
  }

  get stopping(): boolean {
    return this.finished || this.abort.signal.aborted;
  }

  /** End the run normally (report / horizon). */
  finish(reason: StopReason): void {
    if (this.finishReason) return;
    this.finishReason = reason;
    if (!this.abort.signal.aborted) this.abort.abort();
    this.wake?.();
  }

  /** Stop everything (kill-switch, limit breach, Lambda timeout). */
  stop(reason: StopReason, detail: string, abortReason: AbortReason = 'stopped'): void {
    if (this.finishReason) return;
    this.abortReason ??= abortReason;
    this.abortDetail ||= detail;
    this.finish(reason);
  }

  /** The abort an agent raises when it notices the run is ending (carries the run's abort reason). */
  stoppedError(): AgentAbort {
    return new AgentAbort(
      this.abortReason ?? 'stopped',
      this.abortDetail || `run ended (${this.finishReason})`,
    );
  }

  elapsedWallMs(): number {
    return this.clock.now() - this.startWallMs;
  }

  // ------------------------------------------------------------------ events
  envelope(actor: Actor, extra: Partial<Omit<RunEventBase, 'runId' | 'seq'>> = {}) {
    return { actor, simMinute: this.sim.simMinute, simTime: this.sim.simTime(), ...extra };
  }

  draft<T extends EventType>(
    type: T,
    payload: EventPayloadMap[T],
    actor: Actor,
    extra: Partial<Omit<RunEventBase, 'runId' | 'seq'>> = {},
  ): EventDraft<T> {
    return draft(type, payload, {
      ...this.envelope(actor, extra),
      wallTime: new Date(this.clock.now()).toISOString(),
    });
  }

  mutationDrafts(
    mutations: SystemMutation[],
    actor: Actor,
    extra: Partial<Omit<RunEventBase, 'runId' | 'seq'>> = {},
    causedBySeq?: number,
  ): EventDraft[] {
    return mutations.map((m) =>
      mutationDraft(
        m,
        { ...this.envelope(actor, extra), wallTime: new Date(this.clock.now()).toISOString() },
        causedBySeq,
      ),
    );
  }

  /**
   * The single write path: events + the mock-state rows they change, in one `store.append` (one transaction).
   * Serialised per run so the local state mirror always matches the store.
   */
  append(drafts: EventDraft[], mutations: SystemMutation[] = []): Promise<RunEvent[]> {
    const run = this.chain.then(async () => {
      const events = await this.deps.store.append(this.runId, drafts, mutations);
      for (const m of mutations) this.applyMutation(m);
      for (const e of events) this.ingest(e);
      return events;
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  async emit<T extends EventType>(
    type: T,
    payload: EventPayloadMap[T],
    actor: Actor,
    extra: Partial<Omit<RunEventBase, 'runId' | 'seq'>> = {},
  ): Promise<RunEvent<T>> {
    const [e] = await this.append([this.draft(type, payload, actor, extra)]);
    return e as RunEvent<T>;
  }

  /** Persist mutations with one `system.mutation` event each (plus optional leading events). */
  async persist(
    mutations: SystemMutation[],
    actor: Actor,
    lead: EventDraft[] = [],
    extra: Partial<Omit<RunEventBase, 'runId' | 'seq'>> = {},
    causedBySeq?: number,
  ): Promise<RunEvent[]> {
    return this.append([...lead, ...this.mutationDrafts(mutations, actor, extra, causedBySeq)], mutations);
  }

  private applyMutation(m: SystemMutation): void {
    const st = this.state as unknown as Record<string, Record<string, Record<string, unknown>>>;
    const sys = (st[m.system] ??= {});
    const ent = (sys[m.entity] ??= {});
    if (m.op === 'delete') delete ent[m.id];
    else ent[m.id] = deepClone(m.after ?? {});
  }

  setInitialState(state: SystemState): void {
    this.state = deepClone(state);
  }

  /** All events seen so far (own and external), in seq order. */
  eventLog(): RunEvent[] {
    return this.events;
  }

  private ingest(e: RunEvent): void {
    if (this.seen.has(e.seq)) return;
    this.seen.add(e.seq);
    const last = this.events[this.events.length - 1];
    if (!last || last.seq < e.seq) this.events.push(e);
    else {
      const i = this.events.findIndex((x) => x.seq > e.seq);
      this.events.splice(i < 0 ? this.events.length : i, 0, e);
    }
    this.handleExternal(e);
  }

  /** Pull events written by others (API: approvals, twists, control). Cheap; call on every iteration and tick. */
  async sync(): Promise<void> {
    for (;;) {
      const page = await this.deps.store.listEvents(this.runId, this.cursor, 500);
      for (const e of page.events) this.ingest(e);
      if (page.events.length) this.cursor = page.events[page.events.length - 1].seq;
      if (!page.hasMore) break;
    }
  }

  private handleExternal(e: RunEvent): void {
    switch (e.type) {
      case 'approval.decision': {
        const d: Decision = {
          decision: e.payload.decision,
          editedArgs: e.payload.editedArgs,
          selectedOptionId: e.payload.selectedOptionId,
          reason: e.payload.reason,
          decidedBy: e.payload.decidedBy,
          seq: e.seq,
        };
        if (!this.decisions.has(e.payload.approvalId)) this.decisions.set(e.payload.approvalId, d);
        this.waiters.get(e.payload.approvalId)?.resolve(this.decisions.get(e.payload.approvalId)!);
        break;
      }
      case 'control.requested':
        void this.applyControl(e.payload.action, e.payload.speed, e.payload.tool);
        break;
      case 'twist.requested':
        this.twistRequests.push({ seq: e.seq, twistId: e.payload.twistId, text: e.payload.text });
        break;
      default:
        break;
    }
  }

  private async applyControl(
    action: 'pause' | 'resume' | 'stop' | 'set_speed' | 'demo_forbidden',
    speed?: number,
    tool?: DemoForbiddenTool,
  ): Promise<void> {
    if (this.finished) return;
    const world: Actor = { kind: 'world' };
    if (action === 'pause' && !this.sim.paused) {
      this.sim.paused = true;
      await this.emit('run.paused', { speed: this.sim.speed }, world);
      await this.deps.store.updateRun(this.runId, { status: 'paused' });
    } else if (action === 'resume' && this.sim.paused) {
      this.sim.paused = false;
      await this.emit('run.resumed', { speed: this.sim.speed }, world);
      await this.deps.store.updateRun(this.runId, { status: 'running' });
    } else if (action === 'stop') {
      this.stop('stopped', 'kill-switch (control.requested stop)');
    } else if (action === 'set_speed' && typeof speed === 'number' && speed > 0) {
      this.sim.speed = speed;
      await this.emit('run.speed_changed', { speed }, world);
      await this.deps.store.updateRun(this.runId, { speed });
    } else if (action === 'demo_forbidden' && this.onDemoForbidden) {
      await this.onDemoForbidden(tool ?? 'defer_defect').catch((err) =>
        this.log({ msg: 'demo_forbidden failed', err: String((err as Error).message) }),
      );
    }
  }

  /** Blocked/idle agents wait here while the run is paused. */
  async waitWhilePaused(): Promise<void> {
    while (this.sim.paused && !this.stopping) {
      await this.idle(500);
      await this.sync();
    }
  }

  /** Sleep up to `ms`, waking early when the event bus delivers something or the run stops. */
  async idle(ms: number): Promise<void> {
    if (this.stopping) return;
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        if (this.wake === finish) this.wake = undefined;
        resolve();
      };
      const prev = this.wake;
      this.wake = () => {
        prev?.();
        finish();
      };
      void this.clock.sleep(ms).then(finish);
    });
  }

  // ------------------------------------------------------------------ approvals
  /**
   * Resolve when an `approval.decision` for `approvalId` exists (polls ≤ 1 s, or wakes on the bus).
   * `auto` (the `human` policy's simulation safety net): once the approval has waited `afterMs` of REAL time (not
   * counted while the run is paused), `approve()` is tried once; it claims the approval conditionally, so when a
   * person (or the browser's countdown) decided first it returns false and the wait picks up that decision instead.
   */
  async waitForDecision(
    approvalId: string,
    auto?: { afterMs: number; approve: () => Promise<boolean> },
  ): Promise<Decision> {
    const existing = this.decisions.get(approvalId);
    if (existing) return existing;
    let resolve!: (d: Decision) => void;
    const promise = new Promise<Decision>((r) => (resolve = r));
    this.waiters.set(approvalId, { resolve, promise });
    let waitedMs = 0;
    let last = this.clock.now();
    let autoTried = !auto || auto.afterMs <= 0;
    try {
      for (;;) {
        const d = this.decisions.get(approvalId);
        if (d) return d;
        if (this.stopping) throw this.stoppedError();
        const now = this.clock.now();
        if (!this.sim.paused) waitedMs += now - last;
        last = now;
        if (!autoTried && auto && waitedMs >= auto.afterMs) {
          autoTried = true;
          await this.sync();
          if (this.decisions.has(approvalId)) continue;
          const ok = await auto.approve().catch((err: unknown) => {
            this.log({ msg: 'simulation auto-approve failed', approvalId, err: String(err) });
            return false;
          });
          this.log({
            msg: ok ? 'simulation auto-approved' : 'simulation auto-approve lost the race',
            approvalId,
          });
          continue;
        }
        const nap = autoTried || !auto ? 500 : Math.max(1, Math.min(500, auto.afterMs - waitedMs));
        await Promise.race([promise, this.idle(nap)]);
        await this.sync();
      }
    } finally {
      this.waiters.delete(approvalId);
    }
  }

  // ------------------------------------------------------------------ refs
  knownRefs(): KnownRefs {
    const out: KnownRefs = {};
    const add = (kind: RefKind, ids: string[]) => {
      const set = (out[kind] ??= new Set());
      for (const id of ids) set.add(id);
    };
    for (const sys of this.registry.systems) {
      const refs = sys.knownRefs(this.state);
      for (const [kind, ids] of Object.entries(refs)) add(kind as RefKind, ids ?? []);
    }
    const approvals = this.events
      .filter((e) => e.type === 'agent.proposal')
      .map((e) => (e as RunEvent<'agent.proposal'>).payload.approvalId);
    if (approvals.length) add('approval', approvals);
    return out;
  }

  // ------------------------------------------------------------------ limits and LLM calls
  /** Run-level hard limits (spec §6). Cost limits of 0 are disabled. Throws a run-level AgentAbort on breach. */
  checkRunLimits(): void {
    const l = this.limits;
    if (this.elapsedWallMs() >= l.wallClockMs) {
      throw new AgentAbort(
        'wall_clock',
        `wall clock ${Math.round(this.elapsedWallMs() / 1000)} s ≥ ${l.wallClockMs / 1000} s`,
        true,
      );
    }
    if (l.maxInputTokensPerRun > 0 && this.totals.inputTokens >= l.maxInputTokensPerRun) {
      throw new AgentAbort(
        'tokens',
        `input tokens ${this.totals.inputTokens} ≥ ${l.maxInputTokensPerRun}`,
        true,
      );
    }
    if (l.budgetUsd > 0 && this.totals.costUsd >= l.budgetUsd) {
      throw new AgentAbort(
        'budget',
        `cost $${this.totals.costUsd.toFixed(4)} ≥ RUN_BUDGET_USD $${l.budgetUsd}`,
        true,
      );
    }
  }

  /** Tool calls made so far by each agent run (per-agent loop-safety cap). */
  private readonly agentToolCalls = new Map<string, number>();

  /**
   * Count one tool call against the loop-safety limits: the per-agent cap (`maxToolCallsPerAgent`, stops only that
   * agent) and the optional run-level cap (`maxToolCallsPerRun`, 0 = none; stops every agent). 0/absent = no cap.
   */
  countToolCall(agentRunId?: string): void {
    const l = this.limits;
    if (l.maxToolCallsPerRun > 0 && this.totals.toolCalls >= l.maxToolCallsPerRun) {
      throw new AgentAbort(
        'tool_calls',
        `tool calls ${this.totals.toolCalls} ≥ ${l.maxToolCallsPerRun} per run`,
        true,
      );
    }
    if (agentRunId !== undefined) {
      const used = this.agentToolCalls.get(agentRunId) ?? 0;
      const cap = l.maxToolCallsPerAgent ?? 0;
      if (cap > 0 && used >= cap) {
        throw new AgentAbort('tool_calls', `tool calls ${used} ≥ ${cap} for this agent`);
      }
      this.agentToolCalls.set(agentRunId, used + 1);
    }
    this.totals.toolCalls++;
  }

  /**
   * Call the model through the router with a pre-call budget reservation: the worst case of this call (prompt
   * priced as cache writes + maxTokens of output) must fit in the remaining RUN_BUDGET_USD, so concurrent calls
   * can never overshoot the cap.
   */
  async callModel(
    req: Omit<LlmRequest, 'model'>,
  ): Promise<RoutedResponse & { latencyMs: number; costUsd: number }> {
    this.checkRunLimits();
    const model = this.router.active.model;
    const estInput = Math.ceil(JSON.stringify({ s: req.system, m: req.messages, t: req.tools }).length / 3);
    const worst = worstCaseUsd(model, estInput, req.maxTokens);
    if (this.limits.budgetUsd > 0 && this.totals.costUsd + this.reservedUsd + worst > this.limits.budgetUsd) {
      throw new AgentAbort(
        'budget',
        `next call worst case $${worst.toFixed(4)} would exceed RUN_BUDGET_USD $${this.limits.budgetUsd} (spent $${this.totals.costUsd.toFixed(4)}, in flight $${this.reservedUsd.toFixed(4)})`,
        true,
      );
    }
    this.reservedUsd += worst;
    const t0 = this.clock.now();
    try {
      const routed = await this.router.complete({ ...req, signal: this.abort.signal });
      const usage: LlmUsage = routed.response.usage;
      const cost = costUsd(routed.model, usage);
      this.totals.inputTokens += totalInputTokens(usage);
      this.totals.outputTokens += usage.outputTokens;
      this.totals.costUsd = Math.round((this.totals.costUsd + cost) * 1e8) / 1e8;
      this.totals.iterations++;
      return { ...routed, latencyMs: Math.max(0, this.clock.now() - t0), costUsd: cost };
    } finally {
      this.reservedUsd = Math.max(0, this.reservedUsd - worst);
    }
  }

  totalsNow(): RunTotals {
    return { ...this.totals, wallMs: Math.max(0, Math.round(this.elapsedWallMs())) };
  }
}
