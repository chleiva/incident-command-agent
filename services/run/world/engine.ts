/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * World engine (spec §8): a discrete clock with 10-second sim ticks (speed ×6 by default). Each tick applies due
 * twists and follow-ups, advances every system's modelled processes (occ.tick owns flight delays), rebuilds the snapshot
 * and recomputes the KPIs. Emits `world.tick` once per sim minute. **Never calls the LLM** (free-text twists are
 * structured by an injected function that runs the author agent).
 */
import type {
  Actor,
  EventDraft,
  Flight,
  RunEvent,
  ScenarioTwist,
  SystemMutation,
  TwistEffect,
} from '@ica/schema';
import { netMutations } from '../systems/util';
import { findInvalidations, type Invalidation } from '../runtime/invalidation';
import { screenText } from '../guardrails/screen-input';
import type { RunContext } from '../runtime/context';
import { computeKpis, kpiValuesChanged, type WorldSnapshot } from './kpi';
import { applyTwistEffects, isValidTwistEffect, twistNoticeText } from './twists';

export const TICK_SIM_SECONDS = 10;
export const TICK_MIN = TICK_SIM_SECONDS / 60;
const WORLD: Actor = { kind: 'world' };

export interface WorldEngineOptions {
  /** Structure a free-text twist into effects (runs the author agent in twist mode). */
  structureTwist?: (text: string) => Promise<TwistEffect[]>;
  toolNames?: string[];
  /** Enforce the agents' wall-clock limit (agent mode). Baseline runs are bounded by the horizon instead. */
  wallClockLimit?: boolean;
  /** Called after an `approval.invalidated` event (agent mode: the owning agent revises its proposal). */
  onInvalidated?: (inv: Invalidation, seq: number) => void;
}

export function describeChange(m: SystemMutation): string {
  const b = (m.before as { status?: unknown } | undefined)?.status;
  const a = (m.after as { status?: unknown } | undefined)?.status;
  if (b !== undefined && a !== undefined && b !== a)
    return `${m.entity} ${m.id}: ${String(b)} → ${String(a)}`;
  return `${m.entity} ${m.id} ${m.op}d`;
}

export function distanceLookup(ctx: RunContext): (flight: string) => number | null {
  const s = ctx.scenario;
  const bySector = new Map(s.aircraft.nextSectors.map((x) => [x.flight, x.distanceKm]));
  return (flight) => {
    const d = bySector.get(flight);
    if (typeof d === 'number') return d;
    const f = ctx.state.occ?.flights?.[flight];
    const t = f
      ? (s.world.distanceTableKm?.[f.from]?.[f.to] ?? s.world.distanceTableKm?.[f.to]?.[f.from])
      : undefined;
    return typeof t === 'number' ? t : null;
  };
}

export class WorldEngine {
  private applied = new Set<string>();
  private invalidated = new Set<string>();
  private lastMinute: number;
  private lastLogLength = -1;
  private pending: Promise<void>[] = [];

  constructor(
    private readonly ctx: RunContext,
    private readonly opts: WorldEngineOptions = {},
  ) {
    this.lastMinute = Math.floor(ctx.sim.simMinute);
  }

  snapshot(): WorldSnapshot {
    return {
      simMinute: this.ctx.sim.simMinute,
      triggerMinute: this.ctx.scenario.trigger.atMinute,
      state: this.ctx.state,
      distanceKm: distanceLookup(this.ctx),
    };
  }

  computeKpis() {
    return computeKpis(this.snapshot(), this.ctx.scenario.kpiParams, this.ctx.eventLog());
  }

  /** Main loop: runs until the run finishes (report, horizon, stop). */
  async run(): Promise<void> {
    const ctx = this.ctx;
    while (!ctx.finished) {
      await ctx.clock.sleep((TICK_SIM_SECONDS * 1000) / Math.max(1, ctx.sim.speed));
      if (ctx.finished) break;
      if (this.opts.wallClockLimit !== false && ctx.elapsedWallMs() >= ctx.limits.wallClockMs) {
        ctx.stop('stopped', `wall clock ${ctx.limits.wallClockMs / 1000} s reached`, 'wall_clock');
        break;
      }
      try {
        await ctx.sync();
      } catch (err) {
        // A failed read of the inbox is retried on the next tick (the store already retried transient errors).
        ctx.log({ msg: 'world sync failed', err: String((err as Error).message) });
      }
      if (ctx.sim.paused || ctx.finished) continue;
      ctx.sim.advance(TICK_MIN);
      // tick() contains each process's failure itself; this is the last line of defence: log, keep ticking.
      await this.tick(TICK_MIN).catch((err: unknown) =>
        ctx.log({ msg: 'world tick failed', err: String((err as Error).message) }),
      );
      if (ctx.logUnwritable) break;
      if (ctx.sim.simMinute >= ctx.limits.horizonMin - 1e-9) {
        ctx.finish('horizon');
        break;
      }
    }
    await Promise.allSettled(this.pending);
  }

  /**
   * Run one world process; a failure is logged, recorded as a `system.error` (best effort) and skipped, so the
   * clock keeps ticking (self-recovery). Only an unwritable event log ends the run (RunContext.logUnwritable).
   */
  private async guard(what: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      const message = `${what}: ${String((err as Error).message)}`.slice(0, 1000);
      this.ctx.log({ msg: 'world process failed (skipped)', what, err: String((err as Error).message) });
      if (this.ctx.logUnwritable) return;
      await this.ctx.emit('system.error', { scope: 'world', message }, WORLD).catch(() => undefined);
    }
  }

  /** One 10-second tick. Public for tests. */
  async tick(dtMin: number): Promise<void> {
    const ctx = this.ctx;
    const now = ctx.sim.simMinute;

    // 1. twists: scheduled, manual (by id) and free text (async, never blocks the clock).
    for (const tw of ctx.scenario.twists) {
      if (this.applied.has(tw.id)) continue;
      const due = tw.afterFirstApproval
        ? (tw.atMinute ?? 0) <= now && this.anyApproval()
        : tw.atMinute !== undefined && tw.atMinute <= now;
      if (due) {
        this.applied.add(tw.id);
        await this.guard(`twist ${tw.id}`, () => this.applyTwist(tw, 'scheduled'));
      }
    }
    while (ctx.twistRequests.length) {
      const req = ctx.twistRequests.shift()!;
      if (req.twistId) {
        const tw = ctx.scenario.twists.find((t) => t.id === req.twistId);
        if (tw) {
          this.applied.add(tw.id);
          await this.guard(`twist ${tw.id}`, () => this.applyTwist(tw, 'manual'));
        } else ctx.log({ msg: 'unknown twist id', twistId: req.twistId });
      } else if (req.text) {
        this.pending.push(
          this.freeTextTwist(req.text).catch((err) =>
            ctx.log({ msg: 'free-text twist failed', err: String(err) }),
          ),
        );
      }
    }

    // 2. follow-ups scheduled by tools.
    const due = ctx.followUps.filter((f) => f.atMinute <= now);
    if (due.length) {
      ctx.followUps.splice(0, ctx.followUps.length, ...ctx.followUps.filter((f) => f.atMinute > now));
      for (const f of due)
        await this.guard(`follow-up ${f.description ?? ''}`.trim(), () =>
          this.persistProcess(f.mutations, f.description),
        );
    }

    // 3. modelled processes of every system (pure tick functions).
    for (const sys of ctx.registry.systems) {
      let muts: SystemMutation[] = [];
      try {
        muts = sys.tick(ctx.state, now, dtMin);
      } catch (err) {
        ctx.log({ msg: 'system tick failed', system: sys.name, err: String((err as Error).message) });
      }
      if (muts.length) await this.guard(`${sys.name} process`, () => this.persistProcess(muts));
    }

    // 3b. approvals whose assumptions no longer hold (a twist or any mutation changed them).
    await this.guard('approval invalidation check', () => this.checkInvalidations());

    // 4. flight delays. The `occ` system owns them (its tick slips the ETD of a non-dispatchable tail, propagates
    //    reactionary delay and marks departures), so the engine only falls back to its simple "STD passed while not
    //    ready" delay for registries without an occ system (test doubles). One writer: no double counting.
    const minute = Math.floor(now + 1e-9);
    const minuteBoundary = minute > this.lastMinute;
    if (minuteBoundary && !this.occOwnsDelays()) {
      await this.guard('flight delays', async () => {
        const muts = this.flightDelayMutations();
        if (muts.length) await this.persistProcess(muts);
      });
    }

    // 5. snapshot + KPIs (on change, and once per minute); world.tick once per minute.
    const logLength = ctx.eventLog().length;
    if (minuteBoundary || logLength !== this.lastLogLength) {
      await this.guard('KPI update', async () => {
        const k = this.computeKpis();
        if (minuteBoundary || kpiValuesChanged(ctx.latestKpis, k)) {
          await ctx.append([ctx.draft('kpi.update', k, WORLD)]);
          ctx.latestKpis = k;
        }
      });
    }
    if (minuteBoundary) {
      this.lastMinute = minute;
      await this.guard('world tick', () =>
        ctx.append([ctx.draft('world.tick', { simMinute: minute }, WORLD)]).then(() => undefined),
      );
    }
    this.lastLogLength = ctx.eventLog().length;
  }

  /** Resume: twists already applied and approvals already invalidated (from the event log) are not repeated. */
  primeFromLog(events: RunEvent[]): void {
    for (const e of events) {
      if (e.type === 'world.twist' && e.payload.twistId) this.applied.add(e.payload.twistId);
      if (e.type === 'approval.invalidated') this.invalidated.add(e.payload.approvalId);
    }
    this.lastMinute = Math.floor(this.ctx.sim.simMinute);
    this.lastLogLength = -1;
  }

  /** True once any proposal has been approved or edited (not rejected). */
  anyApproval(): boolean {
    return this.ctx.eventLog().some((e) => e.type === 'approval.decision' && e.payload.decision !== 'reject');
  }

  /** Emit `approval.invalidated` for approved proposals whose assumptions changed (task 06 §1.7). */
  async checkInvalidations(): Promise<void> {
    const ctx = this.ctx;
    for (const inv of findInvalidations(ctx.eventLog(), ctx.state, this.invalidated)) {
      this.invalidated.add(inv.approvalId);
      const e = await ctx.emit(
        'approval.invalidated',
        {
          approvalId: inv.approvalId,
          affectedAssumptions: inv.affected,
          ...(inv.causedBySeq ? { causedBySeq: inv.causedBySeq } : {}),
          ...(inv.role ? { role: inv.role } : {}),
        },
        WORLD,
      );
      this.opts.onInvalidated?.(inv, e.seq);
    }
  }

  async persistProcess(raw: SystemMutation[], description?: string): Promise<void> {
    const ctx = this.ctx;
    // One net mutation per row per process step (a store transaction may not touch one row twice).
    const mutations = netMutations(raw);
    const drafts: EventDraft[] = [];
    for (const m of mutations) {
      drafts.push(
        ctx.draft(
          'world.process',
          {
            system: m.system,
            entity: m.entity,
            id: m.id,
            change: (description ?? describeChange(m)).slice(0, 300),
          },
          WORLD,
        ),
        ...ctx.mutationDrafts([m], WORLD),
      );
    }
    await ctx.append(drafts, mutations);
  }

  /** True when a registered `occ` system models flight delays (the real registry). */
  occOwnsDelays(): boolean {
    return this.ctx.registry.systems.some((sys) => sys.name === 'occ');
  }

  /**
   * Fallback for registries without an `occ` system: delay the next undeparted flight of every tail whose aircraft
   * is not ready once its STD has passed.
   */
  flightDelayMutations(): SystemMutation[] {
    const ctx = this.ctx;
    const now = ctx.sim.simMinute;
    const flights = Object.values(ctx.state.occ?.flights ?? {}) as Flight[];
    const byTail = new Map<string, Flight[]>();
    for (const f of flights) {
      if (!['scheduled', 'delayed', 'boarding'].includes(f.status)) continue;
      byTail.set(f.tail, [...(byTail.get(f.tail) ?? []), f]);
    }
    const out: SystemMutation[] = [];
    for (const [tail, list] of byTail) {
      const aircraft = ctx.state.mne?.aircraft?.[tail];
      const openDefect = Object.values(ctx.state.mne?.defects ?? {}).some(
        (d) => d.tail === tail && d.status === 'open',
      );
      const ready = aircraft
        ? aircraft.status === 'released' || (aircraft.status === 'serviceable' && !openDefect)
        : !openDefect;
      if (ready) continue;
      const next = [...list].sort((a, b) => a.std.localeCompare(b.std))[0];
      const stdMin = ctx.sim.minuteOf(next.std);
      if (!(now > stdMin + next.delayMin)) continue;
      const delayMin = Math.ceil(now - stdMin);
      if (delayMin <= next.delayMin) continue;
      const after = {
        ...next,
        delayMin,
        status: 'delayed' as const,
        etd: ctx.sim.simTime(stdMin + delayMin),
      };
      out.push({
        system: 'occ',
        entity: 'flights',
        id: next.flight,
        op: 'update',
        before: { ...next },
        after,
      });
    }
    return out;
  }

  async applyTwist(
    tw: Pick<ScenarioTwist, 'title' | 'description' | 'effects'> & { id?: string },
    source: 'scheduled' | 'manual' | 'free_text',
  ): Promise<void> {
    const ctx = this.ctx;
    const res = applyTwistEffects(ctx.state, tw.effects, ctx.sim.simMinute);
    res.mutations = netMutations(res.mutations);
    if (res.errors.length) ctx.log({ msg: 'twist effects skipped', twistId: tw.id, errors: res.errors });
    const [twistEvent] = await ctx.append(
      [
        ctx.draft(
          'world.twist',
          {
            ...(tw.id ? { twistId: tw.id } : {}),
            title: tw.title,
            description: tw.description,
            source,
            effects: tw.effects,
          },
          WORLD,
        ),
        ...ctx.mutationDrafts(res.mutations, WORLD),
      ],
      res.mutations,
    );
    ctx.twistFeed.push({
      seq: twistEvent.seq,
      title: tw.title,
      text: twistNoticeText(tw.description, res.infos),
    });
  }

  /** Free text → screen → author agent (twist mode) → validated effects, else `{op:'info'}`. */
  async freeTextTwist(raw: string): Promise<void> {
    const ctx = this.ctx;
    const screening = await screenText(raw, { toolNames: this.opts.toolNames });
    let text = raw;
    if (screening.verdict !== 'clean') {
      text = screening.neutralisedText ?? raw;
      await ctx.emit(
        'guardrail.blocked',
        {
          layer: 'input_screen',
          reason: `free-text twist ${screening.verdict}: ${screening.findings.map((f) => f.pattern).join(', ')}`,
          excerpt: screening.findings[0]?.excerpt,
        },
        WORLD,
      );
    }
    let effects: TwistEffect[] = [];
    if (screening.verdict === 'clean' && this.opts.structureTwist) {
      try {
        effects = (await this.opts.structureTwist(text)).filter(isValidTwistEffect);
      } catch (err) {
        ctx.log({ msg: 'twist structuring failed', err: String((err as Error).message) });
      }
    }
    if (ctx.finished) return;
    const probe = applyTwistEffects(ctx.state, effects);
    if (!effects.length || (!probe.mutations.length && !probe.infos.length)) effects = [{ op: 'info', text }];
    await this.applyTwist({ title: 'Presenter twist', description: text, effects }, 'free_text');
  }
}
