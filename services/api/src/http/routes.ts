/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** Route implementations (spec §5 + CLAUDE.md additions). One function per `API_ROUTES` entry. */
import {
  ApprovalDecisionRequestSchema,
  AuthorScenarioRequestSchema,
  ControlRequestSchema,
  CreateRunRequestSchema,
  MAX_EVENTS_PAGE,
  STATE_SYSTEM_NAMES,
  TwistRequestSchema,
  ZERO_TOTALS,
  approvalStatusFor,
  compileSchema,
  draft,
  summariseScenario,
  validateScenario,
  type Actor,
  type AppConfig,
  type ApprovalDecisionResponse,
  type AuthorScenarioResponse,
  type ControlResponse,
  type CreateRunRequest,
  type CreateRunResponse,
  type EventDraft,
  type EvidencePack,
  type ExportResponse,
  type ListEventsResponse,
  type ListRunsResponse,
  type ListScenariosResponse,
  type RunEvent,
  type RunMeta,
  type RunStatus,
  type Scenario,
  type StateSystemName,
  type SystemStateResponse,
  type TwistResponse,
} from '@ica/schema';
import { buildAppConfig } from '../config/app-config';
import { errorFields, silentLogger } from '../util/log';
import { isNotImplemented, type ApiDeps } from './deps';
import { buildFlightScenario } from './flight-context';
import { HttpError, badRequest, conflict, notFound, validationFailed } from './errors';
import { createRouter, humanActor, type RouteContext, type RouteTable } from './router';

const ENDED: RunStatus[] = ['completed', 'aborted', 'failed'];
const ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const DEFAULT_EXPORT_INLINE_MAX = 5 * 1024 * 1024;

const validators = {
  author: compileSchema(AuthorScenarioRequestSchema),
  createRun: compileSchema(CreateRunRequestSchema),
  approval: compileSchema(ApprovalDecisionRequestSchema),
  twist: compileSchema(TwistRequestSchema),
  control: compileSchema(ControlRequestSchema),
};

function validate<T>(
  v: (x: unknown) => { ok: true; value: T } | { ok: false; errors: string[] },
  x: unknown,
): T {
  if (x === undefined) throw badRequest('request body is required');
  const r = v(x);
  if (!r.ok) throw validationFailed(r.errors);
  return r.value;
}

function intParam(raw: string | undefined, name: string, def: number, min: number, max: number): number {
  if (raw === undefined || raw === '') return def;
  if (!/^\d+$/.test(raw)) throw badRequest(`${name} must be a non-negative integer`);
  const n = Number(raw);
  if (n < min || n > max) throw badRequest(`${name} must be between ${min} and ${max}`);
  return n;
}

export function startOfDayUtc(d: Date): string {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}

export function defaultRunId(now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const rand = Math.random().toString(36).slice(2, 8).padEnd(6, '0');
  return `run-${stamp}-${rand}`;
}

/** Build the HTTP API handler (Lambda and local dev server share it). */
export function createApiHandler(deps: ApiDeps) {
  const { store, settings } = deps;
  const log = deps.log ?? silentLogger;
  const now = deps.now ?? (() => new Date());
  const newRunId = deps.newRunId ?? (() => defaultRunId(now()));
  const exportMax = deps.exportInlineMaxBytes ?? DEFAULT_EXPORT_INLINE_MAX;
  const configTtl = deps.configTtlMs ?? 60_000;
  let configCache: { at: number; value: AppConfig } | null = null;

  const findPublic = (id: string) => deps.publicScenarios.find((s) => s.id === id);
  async function findScenario(id: string): Promise<Scenario | null> {
    return findPublic(id) ?? (await store.getScenario(id));
  }

  const scenarioFromFlight = (ctx: RouteContext, req: CreateRunRequest) =>
    buildFlightScenario(deps, req, now().getTime(), ctx.log);

  async function requireRun(ctx: RouteContext): Promise<RunMeta> {
    const runId = ctx.params.id;
    if (!ID_RE.test(runId)) throw notFound('run', 'run_not_found');
    const meta = await store.getRun(runId);
    if (!meta) throw notFound('run', 'run_not_found');
    return meta;
  }

  function requireActive(meta: RunMeta): void {
    if (ENDED.includes(meta.status)) throw conflict('run_ended', `run is ${meta.status}`);
  }

  /** Envelope for API-written events: stamped at the run's current sim time (from its latest event). */
  async function envelopeFor(meta: RunMeta, actor: Actor) {
    let simMinute = meta.simMinute;
    let simTime = now().toISOString();
    if (meta.lastSeq > 0) {
      const page = await store.listEvents(meta.runId, meta.lastSeq - 1, 1);
      const last = page.events.at(-1);
      if (last) {
        simMinute = last.simMinute;
        simTime = last.simTime;
      }
    }
    return { actor, simMinute, simTime };
  }

  async function appendOne(runId: string, d: EventDraft): Promise<RunEvent> {
    const [e] = await store.append(runId, [d]);
    return e;
  }

  const routes: RouteTable = {
    // ---------------------------------------------------------------- scenarios
    async listScenarios() {
      const priv = await store.listScenarios();
      const publicIds = new Set(deps.publicScenarios.map((s) => s.id));
      const items = [
        ...deps.publicScenarios.map(summariseScenario),
        ...priv.filter((s) => !publicIds.has(s.id)),
      ];
      return { body: { items } satisfies ListScenariosResponse };
    },

    async getScenario(ctx) {
      const s = ID_RE.test(ctx.params.id) ? await findScenario(ctx.params.id) : null;
      if (!s) throw notFound('scenario', 'scenario_not_found');
      return { body: s };
    },

    async authorScenario(ctx) {
      const { text } = validate(validators.author, ctx.body);
      let result;
      try {
        result = await deps.author.author(text);
      } catch (err) {
        if (isNotImplemented(err)) {
          throw new HttpError(501, 'not_implemented', 'the Scenario Author is not available yet');
        }
        ctx.log.error('author invocation failed', errorFields(err));
        throw new HttpError(502, 'author_failed', 'the Scenario Author failed');
      }
      if (result.screening?.verdict === 'rejected') {
        throw new HttpError(422, 'input_rejected', 'the text was rejected by input screening', {
          screening: result.screening,
        });
      }
      const out: AuthorScenarioResponse = { screening: result.screening, errors: result.errors };
      if (result.scenario) {
        const v = validateScenario({ ...result.scenario, visibility: 'private' });
        if (!v.ok) {
          out.errors = [...(result.errors ?? []), ...v.errors];
        } else {
          let scenario = v.value;
          if (findPublic(scenario.id)) {
            const suffix = `-a${Math.random().toString(36).slice(2, 6)}`;
            scenario = { ...scenario, id: `${scenario.id.slice(0, 64 - suffix.length)}${suffix}` };
          }
          await store.putScenario(scenario);
          out.scenario = scenario;
          ctx.annotate({ scenarioId: scenario.id });
        }
      }
      if (!out.errors?.length) delete out.errors;
      return { body: out };
    },

    // ---------------------------------------------------------------- runs
    async createRun(ctx) {
      const req = validate(validators.createRun, ctx.body);
      let scenario: Scenario | null;
      let extra: Pick<CreateRunResponse, 'screening' | 'authorFallback'> = {};
      if (req.flightContext) {
        if (req.scenarioId) throw badRequest('give either scenarioId or flightContext, not both');
        const built = await scenarioFromFlight(ctx, req);
        scenario = built.scenario;
        extra = built.extra;
      } else {
        if (!req.scenarioId) throw badRequest('scenarioId or flightContext is required');
        scenario = await findScenario(req.scenarioId);
      }
      if (!scenario) throw notFound('scenario', 'scenario_not_found');
      if (req.pairedRunId && !(await store.getRun(req.pairedRunId))) {
        throw notFound('paired run', 'paired_run_not_found');
      }
      const t = now();
      const count = settings.maxRunsPerDay > 0 ? await store.countRunsSince(startOfDayUtc(t)) : 0;
      if (settings.maxRunsPerDay > 0 && count >= settings.maxRunsPerDay) {
        throw new HttpError(429, 'daily_run_limit', `daily run limit reached (${settings.maxRunsPerDay})`);
      }
      const runId = newRunId();
      const speed = req.speed ?? settings.defaultSpeed;
      const { llm } = settings;
      const meta: RunMeta = {
        runId,
        scenarioId: scenario.id,
        scenarioTitle: scenario.title,
        mode: req.mode,
        status: 'created',
        createdAt: t.toISOString(),
        simMinute: 0,
        lastSeq: 0,
        totals: { ...ZERO_TOTALS },
        speed,
        llm: { provider: llm.provider, model: llm.model },
        updatedAt: t.toISOString(),
      };
      if (req.pairedRunId) meta.pairedRunId = req.pairedRunId;
      await store.createRun(meta);
      ctx.annotate({ runId });
      await appendOne(
        runId,
        draft(
          'run.created',
          {
            scenarioId: scenario.id,
            mode: req.mode,
            ...(req.pairedRunId ? { pairedRunId: req.pairedRunId } : {}),
            speed,
            config: {
              provider: llm.provider,
              model: llm.model,
              limits: llm.limits,
              ...(llm.fallback ? { fallback: llm.fallback } : {}),
            },
          },
          { actor: humanActor(ctx.principal), simMinute: 0, simTime: scenario.startSimTime },
        ),
      );
      try {
        await deps.launcher.launch(runId);
      } catch (err) {
        ctx.log.error('run launch failed', { runId, ...errorFields(err) });
        const message = 'the run could not be started';
        await store.updateRun(runId, { status: 'failed', error: message, endedAt: now().toISOString() });
        await appendOne(
          runId,
          draft(
            'run.failed',
            { error: message, where: 'api.launch' },
            { actor: { kind: 'world' }, simMinute: 0, simTime: scenario.startSimTime },
          ),
        );
        throw new HttpError(502, 'launch_failed', message, { runId });
      }
      return { status: 201, body: { runId, scenarioId: scenario.id, ...extra } satisfies CreateRunResponse };
    },

    async listRuns(ctx) {
      const limit = intParam(ctx.query.limit, 'limit', 20, 1, 100);
      return { body: { items: await store.listRuns(limit) } satisfies ListRunsResponse };
    },

    async getRun(ctx) {
      return { body: await requireRun(ctx) };
    },

    async listEvents(ctx) {
      const meta = await requireRun(ctx);
      const after = intParam(ctx.query.after, 'after', 0, 0, Number.MAX_SAFE_INTEGER);
      const limit = intParam(ctx.query.limit, 'limit', MAX_EVENTS_PAGE, 1, MAX_EVENTS_PAGE);
      const page = await store.listEvents(meta.runId, after, limit);
      return { body: page satisfies ListEventsResponse };
    },

    async decideApproval(ctx) {
      const meta = await requireRun(ctx);
      const approvalId = ctx.params.approvalId;
      const req = validate(validators.approval, ctx.body);
      const rec = ID_RE.test(approvalId) ? await store.getApproval(meta.runId, approvalId) : null;
      if (!rec) throw notFound('approval', 'approval_not_found');
      if (rec.status !== 'pending') throw conflict('approval_not_pending', `approval is ${rec.status}`);
      requireActive(meta);
      if (req.decision === 'edit' && !req.editedArgs) {
        throw validationFailed(['/editedArgs is required when decision is edit']);
      }
      if (req.selectedOptionId && !rec.options?.some((o) => o.id === req.selectedOptionId)) {
        throw validationFailed([`/selectedOptionId unknown option ${req.selectedOptionId}`]);
      }
      const decidedBy = humanActor(ctx.principal, req.roleTitle ?? 'Duty Manager');
      const payload = {
        approvalId,
        decision: req.decision,
        ...(req.editedArgs ? { editedArgs: req.editedArgs } : {}),
        ...(req.selectedOptionId ? { selectedOptionId: req.selectedOptionId } : {}),
        ...(req.reason ? { reason: req.reason } : {}),
        decidedBy,
      };
      // Claim the approval atomically first: of two simultaneous decisions only one passes this conditional update,
      // so only one `approval.decision` event is ever written.
      const status = approvalStatusFor(req.decision);
      if (!(await store.decideApproval(meta.runId, approvalId, 'pending', { status }))) {
        const now = await store.getApproval(meta.runId, approvalId);
        throw conflict('approval_not_pending', `approval is ${now?.status ?? 'gone'}`);
      }
      let e: Awaited<ReturnType<typeof appendOne>>;
      try {
        e = await appendOne(
          meta.runId,
          draft('approval.decision', payload, await envelopeFor(meta, decidedBy)),
        );
      } catch (err) {
        await store
          .decideApproval(meta.runId, approvalId, status, { status: 'pending', decision: undefined })
          .catch(() => {});
        throw err;
      }
      await store.decideApproval(meta.runId, approvalId, status, {
        decision: {
          decision: req.decision,
          ...(req.editedArgs ? { editedArgs: req.editedArgs } : {}),
          ...(req.selectedOptionId ? { selectedOptionId: req.selectedOptionId } : {}),
          ...(req.reason ? { reason: req.reason } : {}),
          decidedBy,
          seq: e.seq,
          decidedAt: e.wallTime,
        },
      });
      ctx.annotate({ approvalId, seq: e.seq });
      return { body: { accepted: true, seq: e.seq } satisfies ApprovalDecisionResponse };
    },

    async injectTwist(ctx) {
      const meta = await requireRun(ctx);
      const req = validate(validators.twist, ctx.body);
      requireActive(meta);
      const actor = humanActor(ctx.principal);
      if ('twistId' in req) {
        const scenario = await findScenario(meta.scenarioId);
        if (!scenario?.twists.some((t) => t.id === req.twistId)) throw notFound('twist', 'twist_not_found');
        const e = await appendOne(
          meta.runId,
          draft('twist.requested', { twistId: req.twistId }, await envelopeFor(meta, actor)),
        );
        return { body: { accepted: true, seq: e.seq } satisfies TwistResponse };
      }
      const screening = await deps.screen(req.text);
      if (screening.verdict === 'rejected') {
        throw new HttpError(422, 'input_rejected', 'the twist text was rejected by input screening', {
          accepted: false,
          screening,
        });
      }
      const text = screening.verdict === 'neutralised' ? (screening.neutralisedText ?? req.text) : req.text;
      const e = await appendOne(
        meta.runId,
        draft('twist.requested', { text }, await envelopeFor(meta, actor)),
      );
      return { body: { accepted: true, seq: e.seq, screening } satisfies TwistResponse };
    },

    async control(ctx) {
      const meta = await requireRun(ctx);
      const req = validate(validators.control, ctx.body);
      if (req.action === 'set_speed' && req.speed === undefined) {
        throw validationFailed(['/speed is required when action is set_speed']);
      }
      requireActive(meta);
      // `demo_forbidden` (task 06): the Run Lambda pushes a synthetic forbidden call through the real tier gate.
      const payload = {
        action: req.action,
        ...(req.action === 'set_speed' ? { speed: req.speed } : {}),
        ...(req.action === 'demo_forbidden' ? { tool: req.tool ?? 'defer_defect' } : {}),
      };
      const actor = humanActor(ctx.principal);
      const e = await appendOne(
        meta.runId,
        draft('control.requested', payload, await envelopeFor(meta, actor)),
      );
      ctx.annotate({ action: req.action, seq: e.seq });
      return { body: { accepted: true, seq: e.seq } satisfies ControlResponse };
    },

    async getSystemState(ctx) {
      const meta = await requireRun(ctx);
      const name = ctx.params.name as StateSystemName;
      if (!(STATE_SYSTEM_NAMES as readonly string[]).includes(name)) {
        throw notFound('system', 'system_not_found');
      }
      const state = (await store.getSystemState(meta.runId, name)) as Record<string, unknown>;
      const entities = (state[name] ?? {}) as SystemStateResponse['entities'];
      return { body: { system: name, entities, asOfSeq: meta.lastSeq } satisfies SystemStateResponse };
    },

    async exportRun(ctx) {
      const meta = await requireRun(ctx);
      const events: RunEvent[] = [];
      let after = 0;
      for (;;) {
        const page = await store.listEvents(meta.runId, after, MAX_EVENTS_PAGE);
        events.push(...page.events);
        if (!page.hasMore || !page.events.length) break;
        after = page.events.at(-1)!.seq;
      }
      const record = (await store.getSystemState(meta.runId, 'record')) as {
        record?: { evidencePacks?: Record<string, EvidencePack> };
      };
      const packs = Object.values(record.record?.evidencePacks ?? {});
      const evidencePack = packs.sort((a, b) => b.createdAtMinute - a.createdAtMinute)[0];
      let trace: ExportResponse['trace'] = events;
      const size = Buffer.byteLength(JSON.stringify(events), 'utf8');
      if (size > exportMax && deps.presign) {
        const key = await deps.traces.put(meta.runId, 'export', events);
        trace = { url: await deps.presign(key) };
      }
      const body: ExportResponse = { trace, ...(evidencePack ? { evidencePack } : {}) };
      return {
        body,
        headers: { 'content-disposition': `attachment; filename="${meta.runId}.export.json"` },
      };
    },

    // ---------------------------------------------------------------- config & evals
    async getConfig() {
      const t = Date.now();
      if (!configCache || t - configCache.at > configTtl) {
        const src = await deps.appConfigSource();
        const priv = await store.listScenarios();
        const scenarioStations = [
          ...deps.publicScenarios.map((s) => s.aircraft.station),
          ...priv.map((s) => s.station),
        ];
        configCache = {
          at: t,
          value: buildAppConfig({ brand: src.brand, stations: src.stations, scenarioStations, settings }),
        };
      }
      return { body: configCache.value };
    },

    async getLatestEval() {
      const r = await store.getLatestEvalReport();
      if (!r) throw notFound('evaluation report', 'eval_not_found');
      return { body: r };
    },
  };

  return createRouter(routes, {
    authMode: settings.authMode,
    corsOrigins: settings.corsOrigins,
    localOperatorName: settings.localOperatorName,
    log,
    ...(deps.resolveUserName ? { resolveUserName: deps.resolveUserName } : {}),
  });
}
