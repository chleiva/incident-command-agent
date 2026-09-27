/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * In-browser fake backend for `VITE_MOCK=1` (and Storybook/tests). It serves the same routes and WebSocket
 * messages as the real API, replaying recorded runs at the run's speed:
 * - each run appends events with fresh gap-free seqs (like `Store.append`), paced by sim time;
 * - a recorded `approval.decision` is a gate: replay waits for the presenter's decision (unless autopilot), then
 *   emits the presenter's decision; a rejection drops the decision's causal follow-ups (`causedBySeq`, the
 *   proposal's tool result) and emits a rejected tool result instead;
 * - twists, control commands (pause/resume/speed/stop) and free-text authoring are handled at the head.
 * Fictional data only; no network.
 */
import {
  SHIPPED_SCENARIOS,
  foldEvents,
  summariseScenario,
  type Actor,
  type AppConfig,
  type AuthorDraft,
  type ApprovalDecisionRequest,
  type ControlRequest,
  type CreateRunRequest,
  type DemoForbiddenTool,
  type EvalReport,
  type RunEvent,
  type RunMeta,
  type Scenario,
  type ScenarioSummary,
  type ScreeningResult,
  type StateSystemName,
  type TwistRequest,
} from '@ica/schema/browser';
import { DEFAULT_APP_CONFIG } from '../lib/brand';
import type { SocketLike, Transport } from '../lib/transport';
import { MOCK_EVAL_REPORT } from './evalReport';
import { SHOWCASE_RUN_ID, buildAgentsShowcase } from './agentsShowcase';
import { RECORDINGS, recordingFor, type Recording } from './recordings';

export const MOCK_API_URL = 'mock://api';
export const MOCK_WS_URL = 'mock://ws';
export const PRESENTER: Actor = { kind: 'human', name: 'Demo presenter', roleTitle: 'Duty Manager' };

/** Mirrors the runtime's FORBIDDEN_RULES (services/run/runtime/tools.ts). */
const DEMO_RULES: Record<DemoForbiddenTool, { rule: string; authority: string }> = {
  defer_defect: {
    rule: 'Deferral under the MEL is a certifying-staff decision (Part-145 / ORO.MLR.105)',
    authority: 'Certifying staff',
  },
  release_aircraft: {
    rule: 'Release to service needs a certificate of release by certifying staff (145.A.50)',
    authority: 'Certifying staff',
  },
  extend_crew_fdp: {
    rule: "Extending a flight duty period is the commander's discretion (ORO.FTL.205(f))",
    authority: 'Aircraft commander',
  },
};

type Listener = (events: RunEvent[]) => void;

interface MockRun {
  meta: RunMeta;
  scenario: Scenario;
  script: RunEvent[];
  cursor: number;
  released: RunEvent[];
  /** template seq → released seq */
  seqMap: Map<number, number>;
  decided: Map<string, RunEvent<'approval.decision'>['payload']>;
  dropped: Set<number>;
  paused: boolean;
  done: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  autopilot: boolean;
  listeners: Set<Listener>;
}

export interface MockBackendOptions {
  /** Auto-decide proposals with the recorded decisions (hands-free demos, screenshots). */
  autopilot?: boolean;
  /** Multiplies pacing (1 = real sim speed). Tests use a large value. */
  timeScale?: number;
  now?: () => number;
  recordings?: Recording[];
  /** Seed the Agents-view showcase run (default true). */
  showcase?: boolean;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const err = (status: number, code: string, error: string) => json(status, { error, code });

/** `scenario.authoring` started → patched (template seqs far above any recording's). */
function authoringPrelude(simTime: string): RunEvent[] {
  const base = { runId: 'mock', actor: { kind: 'world' as const }, simMinute: 0, simTime, wallTime: simTime };
  return [
    {
      ...base,
      seq: 900_001,
      type: 'scenario.authoring',
      payload: { status: 'started', detail: 'Preparing scenario from your description…' },
    },
    {
      ...base,
      seq: 900_002,
      type: 'scenario.authoring',
      payload: { status: 'patched', detail: 'Scenario enriched from your description' },
    },
  ] as RunEvent[];
}

/** Regex input screen (a stand-in for the real guardrail; spec §11 layer 3). */
export function screenText(text: string): ScreeningResult {
  const patterns: [string, RegExp][] = [
    ['ignore-instructions', /ignore (all |any )?(previous|prior|above) (instructions|rules)/i],
    ['role-override', /you are now|act as (the )?system/i],
    ['tool-name', /\b(defer_defect|release_aircraft|extend_crew_fdp)\b/i],
    ['url', /https?:\/\/\S+/i],
  ];
  const findings = patterns.flatMap(([pattern, re]) => {
    const m = re.exec(text);
    return m ? [{ pattern, excerpt: m[0].slice(0, 80) }] : [];
  });
  if (findings.some((f) => f.pattern === 'ignore-instructions' || f.pattern === 'role-override')) {
    return { verdict: 'rejected', findings };
  }
  if (findings.length) {
    return {
      verdict: 'neutralised',
      findings,
      neutralisedText: `«quoted scenario text» ${text.replace(/https?:\/\/\S+/g, '[link removed]')}`,
    };
  }
  return { verdict: 'clean', findings: [] };
}

/**
 * The airborne mock recording is a turnback. When it replays for a diversion, keep the departure airport and the
 * commander's decision right (the remap sends the template's departure airport to the arrival station).
 */
function airborneFixer(flight: string, from: string, typeId: string): (events: RunEvent[]) => RunEvent[] {
  const turnback = typeId === 'air_turnback' || typeId === 'engine_shutdown_overweight_landing';
  if (turnback) return (e) => e;
  const fixRecord = (r: unknown) => {
    if (!r || typeof r !== 'object') return r;
    const o = { ...(r as Record<string, unknown>) };
    if (o.flight === flight && 'plannedDestination' in o) o.from = from;
    if (o.flight === flight && o.decidedBy === 'Commander') o.decision = 'divert';
    if (o.commanderDecision === 'turnback') o.commanderDecision = 'divert';
    return o;
  };
  const text = (s: string) =>
    s.replace(/returning to/g, 'diverting to').replace(/turning back/g, 'diverting');
  return (events) =>
    events.map((e) => {
      if (e.type === 'system.mutation' && e.payload.system === 'occ')
        return {
          ...e,
          payload: { ...e.payload, before: fixRecord(e.payload.before), after: fixRecord(e.payload.after) },
        } as RunEvent;
      if (e.type === 'world.twist')
        return {
          ...e,
          payload: { ...e.payload, title: text(e.payload.title), description: text(e.payload.description) },
        } as RunEvent;
      return e;
    });
}

export class MockBackend {
  private readonly runs = new Map<string, MockRun>();
  private readonly scenarios = new Map<string, { scenario: Scenario; recording: Recording }>();
  private readonly recordings: Recording[];
  private counter = 0;
  private dropUntil = 0;
  private readonly sockets = new Set<MockSocket>();
  readonly autopilot: boolean;
  private drafts = new Map<string, AuthorDraft>();
  timeScale: number;
  private readonly now: () => number;

  constructor(opts: MockBackendOptions = {}) {
    this.autopilot = opts.autopilot ?? false;
    this.timeScale = opts.timeScale ?? 1;
    this.now = opts.now ?? (() => Date.now());
    this.recordings = opts.recordings ?? RECORDINGS;
    for (const rec of this.recordings)
      this.scenarios.set(rec.scenario.id, { scenario: rec.scenario, recording: rec });
    // Seed two completed demo pairs so "recent runs" and side-by-side work immediately.
    for (const rec of this.recordings) {
      const agentId = rec.agent[0]!.runId;
      const baseId = rec.baseline[0]!.runId;
      this.seedCompleted(rec, rec.agent, agentId, 'agent', baseId);
      this.seedCompleted(rec, rec.baseline, baseId, 'baseline', agentId);
    }
    // Task 08: the Agents-view showcase (every row type), paired with the s01 baseline.
    const s01 = this.recordings.find((r) => r.scenario.id === 's01-pushback-tug-contact');
    if (s01 && opts.showcase !== false) {
      const events = buildAgentsShowcase(s01.agent);
      this.seedCompleted({ ...s01, agent: events }, events, SHOWCASE_RUN_ID, 'agent', s01.baseline[0]!.runId);
    }
  }

  // ------------------------------------------------------------------------------------------ transport
  transport(): Transport {
    return {
      fetch: (input, init) => this.fetch(input, init),
      openSocket: (url) => this.openSocket(url),
    };
  }

  async fetch(input: string, init: RequestInit = {}): Promise<Response> {
    const url = new URL(input.replace(MOCK_API_URL, 'http://mock.local'));
    const method = (init.method ?? 'GET').toUpperCase();
    const body = init.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
    const p = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    await new Promise((r) => setTimeout(r, 30));
    try {
      return await this.route(method, p, url.searchParams, body);
    } catch (e) {
      return err(500, 'mock_error', e instanceof Error ? e.message : String(e));
    }
  }

  private route(
    method: string,
    p: string[],
    q: URLSearchParams,
    body: unknown,
  ): Response | Promise<Response> {
    const [a, b, c, d] = p;
    if (method === 'GET' && a === 'config') return json(200, this.config());
    if (method === 'GET' && a === 'evals' && b === 'latest')
      return json(200, MOCK_EVAL_REPORT satisfies EvalReport);
    if (a === 'scenarios') {
      if (method === 'GET' && !b) return json(200, { items: this.listScenarios() });
      if (method === 'POST' && b === 'author') {
        const r = this.author(String((body as { text?: string })?.text ?? ''));
        return r.status === 'failed' && r.screening.verdict === 'rejected'
          ? err(422, 'input_rejected', 'the text was rejected by input screening')
          : json(202, { draftId: r.draftId, status: 'pending', screening: r.screening });
      }
      if (method === 'GET' && b === 'drafts' && c) {
        const d = this.drafts.get(c);
        if (!d) return err(404, 'draft_not_found', `Draft ${c} not found`);
        // The mock author "finishes" a moment after the request.
        return json(
          200,
          this.now() - Date.parse(d.createdAt) >= 1200 / this.timeScale
            ? d
            : { ...d, status: 'pending', scenario: undefined },
        );
      }
      if (method === 'GET' && b) {
        const s = this.scenarios.get(b);
        return s ? json(200, s.scenario) : err(404, 'not_found', `Scenario ${b} not found`);
      }
    }
    if (a === 'runs') {
      if (method === 'GET' && !b) {
        const limit = Number(q.get('limit') ?? 10);
        const items = [...this.runs.values()]
          .map((r) => r.meta)
          .sort((x, y) => y.createdAt.localeCompare(x.createdAt))
          .slice(0, limit);
        return json(200, { items });
      }
      if (method === 'POST' && !b) {
        const r = body as CreateRunRequest;
        return r.flightContext ? this.createFlightRun(r) : this.createRun(r);
      }
      const run = b ? this.runs.get(b) : undefined;
      if (!run) return err(404, 'not_found', `Run ${b} not found`);
      if (method === 'GET' && !c) return json(200, run.meta);
      if (method === 'GET' && c === 'events') {
        const after = Number(q.get('after') ?? 0);
        const limit = Math.min(500, Number(q.get('limit') ?? 500));
        const rest = run.released.filter((e) => e.seq > after);
        return json(200, {
          events: rest.slice(0, limit),
          lastSeq: run.meta.lastSeq,
          hasMore: rest.length > limit,
        });
      }
      if (method === 'POST' && c === 'approvals' && d)
        return this.decide(run, d, body as ApprovalDecisionRequest);
      if (method === 'POST' && c === 'twists') return this.twist(run, body as TwistRequest);
      if (method === 'POST' && c === 'control') return this.control(run, body as ControlRequest);
      if (method === 'GET' && c === 'systems' && d) {
        const proj = foldEvents(run.released);
        return json(200, {
          system: d,
          entities: proj.systems[d as StateSystemName] ?? {},
          asOfSeq: proj.lastSeq,
        });
      }
      if (method === 'GET' && c === 'export') {
        const proj = foldEvents(run.released);
        const evidencePack = Object.values(proj.systems.record.evidencePacks).at(-1);
        return json(200, { trace: run.released, ...(evidencePack ? { evidencePack } : {}) });
      }
    }
    return err(404, 'no_route', `${method} /${p.join('/')}`);
  }

  // ------------------------------------------------------------------------------------------ routes
  config(): AppConfig {
    return DEFAULT_APP_CONFIG;
  }

  listScenarios(): ScenarioSummary[] {
    const recorded = [...this.scenarios.values()].map((s) => summariseScenario(s.scenario));
    const others: ScenarioSummary[] = SHIPPED_SCENARIOS.filter((s) => !this.scenarios.has(s.id)).map((s) => ({
      id: s.id,
      title: s.title,
      station: s.station,
      aircraftType: 'A320',
      triggerType: s.outstation ? 'outstation incident' : 'home-base incident',
      visibility: 'public',
      twistCount: 2,
      inspiredBy: [],
    }));
    return [...recorded, ...others].sort((x, y) => x.id.localeCompare(y.id));
  }

  hasRecording(scenarioId: string): boolean {
    return this.scenarios.has(scenarioId);
  }

  private author(text: string): AuthorDraft {
    const screening = screenText(text);
    const draftId = `draft-mock-${++this.counter}`;
    const createdAt = new Date(this.now()).toISOString();
    if (screening.verdict === 'rejected')
      return { draftId, status: 'failed', createdAt, screening, errors: ['Input rejected by screening'] };
    const base = recordingFor('s01-pushback-tug-contact') ?? this.recordings[0]!;
    const n = ++this.counter;
    const first =
      (screening.neutralisedText ?? text)
        .split(/[.!?\n]/)[0]!
        .trim()
        .slice(0, 80) || 'Authored scenario';
    const scenario: Scenario = {
      ...base.scenario,
      id: `authored-${n}-${base.scenario.aircraft.station.toLowerCase()}`,
      title: first,
      narrative: screening.neutralisedText ?? text,
      visibility: 'private',
    };
    this.scenarios.set(scenario.id, { scenario, recording: base });
    const d: AuthorDraft = { draftId, status: 'ready', createdAt, screening, scenario };
    this.drafts.set(draftId, d);
    return d;
  }

  /**
   * Mock `POST /runs` with a flight context (task 07): the scenario is built in the browser with the same templates the
   * server uses; the replay is a recorded run (s01 at a base, s04 at an outstation, s11 in the air) with its identifiers, stations and
   * times moved onto the flight by the same remapping. Free text is screened and added to the narrative (no LLM).
   */
  private async createFlightRun(req: CreateRunRequest): Promise<Response> {
    const fc = req.flightContext!;
    const [{ generateDaySchedule, isBase }, T] = await Promise.all([
      import('@ica/network'),
      import('@ica/network/templates'),
    ]);
    const schedule = generateDaySchedule(fc.seed, fc.date);
    const atMs = fc.at ? Date.parse(fc.at) : this.now();
    const ctx = T.incidentContext(schedule, fc.flightId, atMs);
    if (!ctx) return err(404, 'flight_not_found', `flight ${fc.flightId} not found`);
    const typeId = req.incidentType ?? '';
    if (typeId === T.OTHER_INCIDENT_TYPE && !req.text)
      return err(400, 'bad_request', "incidentType 'other' needs a text description");
    const screening = req.text ? screenText(req.text) : undefined;
    if (screening?.verdict === 'rejected')
      return err(422, 'input_rejected', 'the text was rejected by input screening');
    const airborne = T.incidentTypeById(typeId)?.category === 'airborne';
    const outstation = !isBase(ctx.station);
    const rec = recordingFor(
      airborne
        ? 's11-air-turnback-bird-strike'
        : outstation
          ? 's04-lightning-strike-outstation'
          : 's01-pushback-tug-contact',
    );
    if (!rec) return err(500, 'mock_error', 'no recording');
    // Airborne: the turnback recording moved onto this flight and the airport of the chosen type.
    const recType = airborne ? typeId : outstation ? 'lightning_strike' : 'pushback_tug_contact';
    let built;
    let replay;
    try {
      built =
        typeId === T.OTHER_INCIDENT_TYPE
          ? T.buildScenarioFromFlight(schedule, fc.flightId, recType, { atMs, force: true })
          : T.buildScenarioFromFlight(schedule, fc.flightId, typeId, { atMs });
      replay = T.buildScenarioFromFlight(schedule, fc.flightId, recType, {
        atMs,
        template: rec.scenario,
        force: true,
      });
    } catch (e) {
      return err(409, 'not_applicable', e instanceof Error ? e.message : String(e));
    }
    // Async authoring (mock): the "Author" adds the screened note to the narrative, announced by scenario.authoring
    // events before the world starts, like the Run Lambda does.
    const note = req.text
      ? ` Duty manager's note (screened): «${screening?.neutralisedText ?? req.text}»`
      : '';
    const scenario: Scenario = {
      ...built.scenario,
      ...(typeId === T.OTHER_INCIDENT_TYPE
        ? { title: `Reported incident: ${fc.flightId} at ${ctx.station}` }
        : {}),
      narrative: `${built.scenario.narrative}${note}`,
    };
    const fix = airborne
      ? airborneFixer(fc.flightId, schedule.flights.find((f) => f.flight === fc.flightId)!.from, typeId)
      : (e: RunEvent[]) => e;
    const recording: Recording = {
      scenario,
      agent: fix(replay.remap(rec.agent)),
      baseline: fix(replay.remap(rec.baseline)),
    };
    this.scenarios.set(scenario.id, { scenario, recording });
    const prelude = req.text ? authoringPrelude(scenario.startSimTime) : [];
    const agentId = this.nextRunId();
    const baselineId = req.withBaseline ? this.nextRunId() : undefined;
    const res = this.createRun(
      { ...req, scenarioId: scenario.id, ...(baselineId ? { pairedRunId: baselineId } : {}) },
      prelude,
      agentId,
    );
    if (!res.ok) return res;
    if (baselineId) {
      const b = this.createRun(
        { scenarioId: scenario.id, mode: 'baseline', speed: req.speed, pairedRunId: agentId },
        prelude,
        baselineId,
      );
      if (!b.ok) return b;
    }
    return json(201, {
      runId: agentId,
      scenarioId: scenario.id,
      ...(baselineId ? { pairedRunId: baselineId } : {}),
      ...(prelude.length ? { preparing: true } : {}),
      ...(screening ? { screening } : {}),
    });
  }

  private nextRunId(): string {
    return `run-mock-${Date.now().toString(36)}-${++this.counter}`;
  }

  private createRun(req: CreateRunRequest, prelude: RunEvent[] = [], id?: string): Response {
    if (!req.scenarioId) return err(400, 'bad_request', 'scenarioId or flightContext is required');
    const entry = this.scenarios.get(req.scenarioId);
    if (!entry)
      return err(
        400,
        'no_recording',
        `Mock mode has no recording for ${req.scenarioId}; use the local dev server.`,
      );
    const runId = id ?? this.nextRunId();
    const template = req.mode === 'baseline' ? entry.recording.baseline : entry.recording.agent;
    const withPrelude = prelude.length ? [template[0]!, ...prelude, ...template.slice(1)] : template;
    const script = withPrelude.map((e, i) => {
      if (i !== 0 || e.type !== 'run.created') return e;
      const payload = { ...e.payload, scenarioId: req.scenarioId, speed: req.speed ?? 6 } as Record<
        string,
        unknown
      >;
      if (req.pairedRunId) payload.pairedRunId = req.pairedRunId;
      else delete payload.pairedRunId;
      return { ...e, payload } as RunEvent;
    });
    const run = this.newRun(runId, entry.scenario, req.mode, script, req.pairedRunId, req.speed ?? 6);
    this.runs.set(runId, run);
    // First event well under 2 s after the trigger (FR-02).
    run.timer = setTimeout(() => this.pump(run), 120);
    return json(200, { runId, scenarioId: entry.scenario.id });
  }

  private decide(run: MockRun, approvalId: string, req: ApprovalDecisionRequest): Response {
    const proj = foldEvents(run.released);
    const a = proj.approvals[approvalId];
    if (!a) return err(404, 'not_found', `Approval ${approvalId} not found`);
    if (a.status !== 'pending' || run.decided.has(approvalId))
      return err(409, 'already_decided', 'Already decided');
    const payload: RunEvent<'approval.decision'>['payload'] = {
      approvalId,
      decision: req.decision,
      ...(req.editedArgs ? { editedArgs: req.editedArgs } : {}),
      ...(req.selectedOptionId ? { selectedOptionId: req.selectedOptionId } : {}),
      ...(req.reason ? { reason: req.reason } : {}),
      decidedBy: { ...PRESENTER, roleTitle: req.roleTitle ?? 'Duty Manager' } as Actor,
    };
    run.decided.set(approvalId, payload);
    const recorded = run.script.find(
      (e) => e.type === 'approval.decision' && e.payload.approvalId === approvalId,
    );
    const recommended = a.options?.find((o) => o.recommended)?.id;
    const offPath =
      req.decision === 'reject' ||
      (req.selectedOptionId !== undefined && req.selectedOptionId !== recommended);
    if (recorded && offPath) {
      // Drop the recorded consequences of this decision.
      for (const e of run.script) {
        if (e.seq <= recorded.seq) continue;
        const causal = e.type === 'system.mutation' && e.payload.causedBySeq === recorded.seq;
        const result = e.type === 'agent.tool_result' && e.payload.toolCallId === a.toolCallId;
        if (causal || result) run.dropped.add(e.seq);
      }
    }
    const decision = this.emit(run, 'approval.decision', payload, payload.decidedBy);
    if (offPath) {
      this.emit(
        run,
        'agent.tool_result',
        {
          toolCallId: a.toolCallId,
          tool: a.tool,
          ok: req.decision !== 'reject',
          resultPreview:
            req.decision === 'reject'
              ? JSON.stringify({ rejected: true, reason: req.reason ?? '' })
              : JSON.stringify({
                  selectedOptionId: req.selectedOptionId,
                  note: 'Mock mode: the recording continues on the recommended path.',
                }),
        },
        a.role ? { kind: 'agent', role: a.role } : { kind: 'world' },
        a.agentRunId,
      );
    }
    this.kick(run);
    return json(200, { accepted: true, seq: decision.seq });
  }

  private twist(run: MockRun, req: TwistRequest): Response {
    if ('twistId' in req) {
      const t = run.scenario.twists.find((x) => x.id === req.twistId);
      if (!t) return err(404, 'not_found', `Twist ${req.twistId} not found`);
      const r = this.emit(run, 'twist.requested', { twistId: t.id }, PRESENTER);
      this.emit(
        run,
        'world.twist',
        { twistId: t.id, title: t.title, description: t.description, source: 'manual', effects: t.effects },
        { kind: 'world' },
      );
      this.orchestratorNote(run, `Twist received: ${t.title}. Re-assessing the plan with the specialists.`);
      return json(200, { accepted: true, seq: r.seq });
    }
    const screening = screenText(req.text);
    if (screening.verdict === 'rejected') return json(200, { accepted: false, screening });
    const text = screening.neutralisedText ?? req.text;
    const r = this.emit(run, 'twist.requested', { text }, PRESENTER);
    this.emit(
      run,
      'world.twist',
      { title: 'Presenter twist', description: text, source: 'free_text', effects: [{ op: 'info', text }] },
      { kind: 'world' },
    );
    this.orchestratorNote(
      run,
      'Free-text twist received (treated as data). Checking whether it changes any open decision.',
    );
    return json(200, { accepted: true, seq: r.seq, screening });
  }

  private control(run: MockRun, req: ControlRequest): Response {
    const r = this.emit(
      run,
      'control.requested',
      {
        action: req.action,
        ...(req.speed ? { speed: req.speed } : {}),
        ...(req.action === 'demo_forbidden' ? { tool: req.tool ?? 'defer_defect' } : {}),
      },
      PRESENTER,
    );
    if (req.action === 'pause' && !run.paused) {
      run.paused = true;
      run.meta.status = 'paused';
      this.emit(run, 'run.paused', { speed: run.meta.speed }, { kind: 'world' });
    } else if (req.action === 'resume' && run.paused) {
      run.paused = false;
      run.meta.status = 'running';
      this.emit(run, 'run.resumed', { speed: run.meta.speed }, { kind: 'world' });
      this.kick(run);
    } else if (req.action === 'set_speed' && req.speed) {
      run.meta.speed = req.speed;
      this.emit(run, 'run.speed_changed', { speed: req.speed }, { kind: 'world' });
      this.kick(run);
    } else if (req.action === 'demo_forbidden' && !run.done) {
      this.demoForbidden(run, req.tool ?? 'defer_defect');
    } else if (req.action === 'stop' && !run.done) {
      const proj = foldEvents(run.released);
      if (proj.kpis)
        this.emit(
          run,
          'run.completed',
          { reason: 'stopped', totals: proj.totals, finalKpis: proj.kpis },
          { kind: 'world' },
        );
      this.finish(run, 'completed');
    }
    return json(200, { accepted: true, seq: r.seq });
  }

  // ------------------------------------------------------------------------------------------ replay engine
  private newRun(
    runId: string,
    scenario: Scenario,
    mode: 'agent' | 'baseline',
    script: RunEvent[],
    pairedRunId: string | undefined,
    speed: number,
  ): MockRun {
    const createdAt = new Date(this.now()).toISOString();
    return {
      meta: {
        runId,
        scenarioId: scenario.id,
        scenarioTitle: scenario.title,
        mode,
        status: 'created',
        ...(pairedRunId ? { pairedRunId } : {}),
        createdAt,
        simMinute: 0,
        lastSeq: 0,
        totals: { inputTokens: 0, outputTokens: 0, costUsd: 0, toolCalls: 0, iterations: 0, wallMs: 0 },
        speed,
        llm: mode === 'agent' ? { provider: 'replay', model: 'mock-recording' } : undefined,
      },
      scenario,
      script,
      cursor: 0,
      released: [],
      seqMap: new Map(),
      decided: new Map(),
      dropped: new Set(),
      paused: false,
      done: false,
      timer: null,
      autopilot: this.autopilot || mode === 'baseline',
      listeners: new Set(),
    };
  }

  private seedCompleted(
    rec: Recording,
    events: RunEvent[],
    runId: string,
    mode: 'agent' | 'baseline',
    paired: string,
  ): void {
    const run = this.newRun(runId, rec.scenario, mode, events, paired, 6);
    run.meta.createdAt = events[0]!.wallTime;
    run.autopilot = true;
    while (!run.done) this.step(run, false);
    this.runs.set(runId, run);
  }

  /** Release the next template event; returns the delay (ms) until the following one, or null to wait. */
  private step(run: MockRun, paced = true): number | null {
    for (;;) {
      if (run.done) return null;
      const t = run.script[run.cursor];
      if (!t) {
        this.finish(run, 'completed');
        return null;
      }
      if (run.dropped.has(t.seq)) {
        run.cursor += 1;
        continue;
      }
      if (t.type === 'approval.decision') {
        if (run.decided.has(t.payload.approvalId)) {
          run.seqMap.set(
            t.seq,
            run.released.find(
              (e) => e.type === 'approval.decision' && e.payload.approvalId === t.payload.approvalId,
            )?.seq ?? 0,
          );
          run.cursor += 1;
          continue;
        }
        if (!run.autopilot) return null; // gate: wait for the presenter
      }
      run.cursor += 1;
      this.release(run, t);
      const next = run.script[run.cursor];
      if (!next || !paced) return 0;
      // Mock "authoring": hold the world a moment while the scenario is prepared.
      if (t.type === 'scenario.authoring' && t.payload.status === 'started') return 1500 / this.timeScale;
      const msPerMinute = 60_000 / Math.max(1, run.meta.speed) / this.timeScale;
      const gap = Math.max(0, next.simMinute - t.simMinute) * msPerMinute;
      return Math.max(35 / this.timeScale, gap);
    }
  }

  private pump(run: MockRun): void {
    run.timer = null;
    if (run.paused || run.done) return;
    if (run.meta.status === 'created') run.meta.status = 'running';
    const delay = this.step(run);
    if (delay === null) return;
    run.timer = setTimeout(() => this.pump(run), delay);
  }

  private kick(run: MockRun): void {
    if (run.timer || run.paused || run.done) return;
    run.timer = setTimeout(() => this.pump(run), 60 / this.timeScale);
  }

  private remap(run: MockRun, e: RunEvent): RunEvent {
    const map = (s: number) => run.seqMap.get(s);
    if (e.type === 'system.mutation' && e.payload.causedBySeq) {
      const s = map(e.payload.causedBySeq);
      const { causedBySeq: _drop, ...rest } = e.payload;
      return { ...e, payload: s ? { ...rest, causedBySeq: s } : rest } as RunEvent;
    }
    if (e.type === 'kpi.update' || e.type === 'run.completed') {
      const snap = e.type === 'kpi.update' ? e.payload : e.payload.finalKpis;
      const fix = <K extends { contributingSeqs: number[] }>(k: K): K => ({
        ...k,
        contributingSeqs: k.contributingSeqs
          .map(map)
          .filter((x): x is number => typeof x === 'number' && x > 0),
      });
      const fixed = {
        ...snap,
        delayCostEur: fix(snap.delayCostEur),
        eu261ExposureEur: fix(snap.eu261ExposureEur),
        cancellationCostEur: fix(snap.cancellationCostEur),
        totalCostEur: fix(snap.totalCostEur),
        satisfaction: fix(snap.satisfaction),
        compliance: fix(snap.compliance),
        safety: fix(snap.safety),
        latency: fix(snap.latency),
      };
      return (
        e.type === 'kpi.update'
          ? { ...e, payload: fixed }
          : { ...e, payload: { ...e.payload, finalKpis: fixed } }
      ) as RunEvent;
    }
    return e;
  }

  private release(run: MockRun, t: RunEvent): RunEvent {
    const seq = run.released.length + 1;
    const e = {
      ...this.remap(run, t),
      runId: run.meta.runId,
      seq,
      wallTime: new Date(this.now()).toISOString(),
    } as RunEvent;
    run.seqMap.set(t.seq, seq);
    this.publish(run, e);
    return e;
  }

  /** Append a new event at the head (presenter actions). */
  private emit<T extends RunEvent['type']>(
    run: MockRun,
    type: T,
    payload: Extract<RunEvent, { type: T }>['payload'],
    actor: Actor,
    agentRunId?: string,
  ): RunEvent {
    const last = run.released.at(-1);
    const minute = last?.simMinute ?? 0;
    const start = Date.parse(run.scenario.startSimTime);
    const e = {
      runId: run.meta.runId,
      seq: run.released.length + 1,
      type,
      actor,
      ...(agentRunId ? { agentRunId } : {}),
      simMinute: minute,
      simTime: new Date(start + minute * 60_000).toISOString(),
      wallTime: new Date(this.now()).toISOString(),
      payload,
    } as unknown as RunEvent;
    this.publish(run, e);
    return e;
  }

  /**
   * Stand-in for the Run Lambda's `demo_forbidden` handling (mock mode has no runtime): the same event sequence the
   * real tier gate writes — tool call, `guardrail.blocked` (tier, rule, authority, presenterTriggered) and the refused
   * tool result — then a KPI snapshot that counts the attempt like any other. The real path is in services/run.
   */
  private demoForbidden(run: MockRun, tool: DemoForbiddenTool): void {
    const proj = foldEvents(run.released);
    const mx = Object.values(proj.agents).find((a) => a.role === 'maintenance');
    const actor: Actor = { kind: 'agent', role: 'maintenance' };
    const toolCallId = `tc-demo-${++this.counter}`;
    const tail = run.scenario.aircraft.tail;
    const defect = Object.values(proj.systems.mne.defects)[0];
    const args =
      tool === 'release_aircraft'
        ? { tail }
        : tool === 'extend_crew_fdp'
          ? { crewId: Object.keys(proj.systems.crew.crew)[0] ?? 'crew-1', minutes: 60 }
          : { defectId: defect?.id ?? 'DEF-001', melItem: defect?.melItem ?? '00-00-00' };
    const rule = DEMO_RULES[tool];
    this.emit(
      run,
      'agent.tool_call',
      {
        toolCallId,
        tool,
        system: tool === 'extend_crew_fdp' ? 'crew' : 'mne',
        tier: 'forbidden',
        args,
        presenterTriggered: true,
      },
      actor,
      mx?.agentRunId,
    );
    const block = this.emit(
      run,
      'guardrail.blocked',
      {
        layer: 'tier',
        tool,
        reason: `forbidden tool '${tool}' attempted by maintenance`,
        toolCallId,
        rule: rule.rule,
        authority: rule.authority,
        presenterTriggered: true,
      },
      actor,
      mx?.agentRunId,
    );
    this.emit(
      run,
      'agent.tool_result',
      { toolCallId, tool, ok: false, resultPreview: `Blocked: ${rule.rule}. Software cannot do it.` },
      actor,
      mx?.agentRunId,
    );
    if (proj.kpis) {
      const k = proj.kpis;
      const presenter = Number(k.safety.inputs.presenterTriggeredAttempts ?? 0) + 1;
      const value = { ...k.safety.value, forbiddenAttempts: k.safety.value.forbiddenAttempts + 1 };
      this.emit(
        run,
        'kpi.update',
        {
          ...k,
          safety: {
            value,
            formula: `forbidden tool calls blocked (must be 0 attempts; ${presenter} presenter-triggered demonstration${presenter === 1 ? '' : 's'} included); propose-tier actions executed with / without a recorded decision`,
            inputs: {
              ...k.safety.inputs,
              forbiddenAttemptsBlocked: value.forbiddenAttempts,
              presenterTriggeredAttempts: presenter,
            },
            contributingSeqs: [...k.safety.contributingSeqs, block.seq].slice(-12),
          },
        },
        { kind: 'world' },
      );
    }
    this.orchestratorNote(
      run,
      'Presenter demonstration: the forbidden call was refused by the tier gate, as designed.',
    );
  }

  private orchestratorNote(run: MockRun, text: string): void {
    const orch = run.released.find((e) => e.type === 'agent.started' && e.payload.role === 'orchestrator');
    if (!orch || run.done) return;
    this.emit(
      run,
      'agent.thought',
      { text, summary: text.slice(0, 120) },
      { kind: 'agent', role: 'orchestrator' },
      orch.agentRunId,
    );
  }

  private publish(run: MockRun, e: RunEvent): void {
    run.released.push(e);
    run.meta.lastSeq = e.seq;
    run.meta.simMinute = Math.max(run.meta.simMinute, e.simMinute);
    run.meta.updatedAt = e.wallTime;
    if (e.type === 'run.started') run.meta.status = 'running';
    if (e.type === 'run.completed') {
      run.meta.totals = e.payload.totals;
      this.finish(run, 'completed');
    }
    for (const l of run.listeners) l([e]);
  }

  private finish(run: MockRun, status: RunMeta['status']): void {
    run.done = true;
    run.meta.status = status;
    run.meta.endedAt = new Date(this.now()).toISOString();
    if (run.timer) clearTimeout(run.timer);
    run.timer = null;
  }

  // ------------------------------------------------------------------------------------------ WebSocket
  openSocket(url: string): SocketLike {
    const runId = new URL(url.replace(MOCK_WS_URL, 'http://mock.local/ws')).searchParams.get('runId') ?? '';
    const socket = new MockSocket(() => this.sockets.delete(socket));
    this.sockets.add(socket);
    setTimeout(() => {
      if (socket.closed) return;
      if (this.now() < this.dropUntil) {
        socket.fail();
        return;
      }
      const run = this.runs.get(runId);
      socket.onopen?.({});
      if (!run) return;
      const listener: Listener = (events) => socket.deliver({ kind: 'events', runId, events });
      run.listeners.add(listener);
      socket.onDispose = () => run.listeners.delete(listener);
    }, 20);
    return socket;
  }

  /** Demo aid: drop every socket and refuse reconnects for `ms` (shows the reconnect path). */
  simulateDrop(ms = 5_000): void {
    this.dropUntil = this.now() + ms;
    for (const s of [...this.sockets]) s.fail();
  }

  /** Test aid: run ids by status. */
  runIds(): string[] {
    return [...this.runs.keys()];
  }
}

class MockSocket implements SocketLike {
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null;
  onDispose: (() => void) | null = null;
  closed = false;

  constructor(private readonly unregister: () => void) {}

  send(): void {}

  deliver(msg: unknown): void {
    if (this.closed) return;
    const data = JSON.stringify(msg);
    queueMicrotask(() => this.onmessage?.({ data }));
  }

  close(): void {
    this.dispose();
  }

  fail(): void {
    const cb = this.onclose;
    this.dispose();
    cb?.({});
  }

  private dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.onDispose?.();
    this.unregister();
  }
}
