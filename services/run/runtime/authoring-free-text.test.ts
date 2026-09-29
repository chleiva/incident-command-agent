/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Authoritative free text (live run 2026-09-29: a volcanic-ash report ran as a fumes diversion). "Something else"
 * builds a neutral base and the Author writes the incident layer, including network-wide effects; failure never
 * substitutes a template. Typed incidents may remove or replace contradicting template content. Scripted provider:
 * no network, no live LLM.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RUN_LIMITS,
  foldEvents,
  validateEvent,
  validateScenario,
  type RunDeps,
  type RunMeta,
  type Scenario,
  type ScenarioPatch,
} from '@ica/schema';
import { flightTimes, generateDaySchedule } from '@ica/network';
import {
  buildNeutralScenarioFromFlight,
  buildScenarioFromFlight,
  networkSlice,
} from '@ica/network/templates';
import { MemoryStore, MemoryTraceStore } from '@ica/store';
import { parseAuthoring } from '../handler';
import { LlmHttpError } from '../llm/errors';
import { call, createScriptedProvider, step, type ScriptFn } from '../llm/scripted';
import { seedOcc } from '../systems/occ';
import { seedMne } from '../systems/mne';
import { VirtualClock } from '../world/clock';
import { fakeKnowledge } from './__fixtures__/registry';
import { ofType } from './__fixtures__/harness';
import {
  AUTHORING_COPY,
  AUTHORING_OTHER_MAX_TOKENS,
  AUTHORING_OTHER_TIMEOUT_MS,
  authorScenarioPatch,
  authoringSlice,
  prepareRunScenario,
} from './authoring';
import { defaultRegistry } from './registry';
import { executeRunWith } from './run';
import { checkScenarioPatch } from './scenario-patch';

const SEED = 'accent-air';
const DATE = '2026-09-27';
const schedule = generateDaySchedule(SEED, DATE);
const ASH = 'UK decided to close air space, volcano eruption has covered european air with ashes';
const FUMES = /fume|smell|acrid|smoke/i;

/** A UK departure in the cruise, like the live report. */
const flight = schedule.flights.find((f) => !f.cancelled && f.from === 'MAN' && f.distanceKm > 1200)!;
const t = flightTimes(flight);
const AT = (t.takeoffMs + t.landingMs) / 2;

function base(): Scenario {
  const b = buildNeutralScenarioFromFlight(schedule, flight.flight, { atMs: AT }).scenario;
  return { ...b, id: `${b.id}-t001` };
}

/** The canned closure patch: the incident flight turns back, other flights held, cancelled or diverted. */
function closurePatch(b: Scenario): ScenarioPatch {
  const slice = networkSlice(schedule, Date.parse(b.startSimTime), {
    text: ASH,
    anchorFlight: flight.flight,
  });
  const others = slice.flights.filter((f) => f.tail !== flight.tail);
  const air = others.filter((f) => f.position).slice(0, 3);
  const ground = others.filter((f) => !f.position).slice(0, 5);
  return {
    title: `UK airspace closed by volcanic ash: ${flight.flight} and ${air.length + ground.length} more flights`,
    replaceNarrative: `Volcanic ash from an eruption covers much of European airspace and the UK has closed its airspace. Accent Air ${flight.flight} is in the air; UK departures are held and flights bound for the UK must divert.`,
    replaceTrigger: {
      type: 'airspace-closure',
      scope: 'network',
      description: 'UK airspace closed: volcanic ash cloud over the UK and much of Europe.',
      evidence: [
        { kind: 'report', text: 'Network manager: UK airspace closed to IFR traffic until further notice.' },
      ],
    },
    commanderDecision: {
      atMinute: 3,
      decision: 'turnback',
      note: 'UK airspace closed ahead; returning to the departure airport.',
    },
    network: {
      flights: [
        ...ground.map((f, i) => ({
          flight: f.flight,
          effect: i % 2 ? ('cancel' as const) : ('hold' as const),
          ...(i % 2 ? {} : { minutes: 180 }),
        })),
        ...air.map((f) => ({ flight: f.flight, effect: 'divert' as const, divertTo: 'CDG', atMinute: 6 })),
      ],
    },
    twists: [
      {
        title: 'Ash forecast extends the closure',
        description: 'The ash forecast extends the UK closure by six hours.',
        atMinute: 60,
        effects: [{ op: 'info', text: 'Ash forecast: the UK closure is extended by six hours.' }],
      },
    ],
  };
}

function deps(script: ScriptFn, clock = new VirtualClock()) {
  const provider = createScriptedProvider(script, { clock, latencyMs: 1000 });
  const d: RunDeps = {
    store: new MemoryStore(),
    traces: new MemoryTraceStore(),
    knowledge: fakeKnowledge(),
    llm: {
      provider: 'scripted',
      model: 'claude-sonnet-5',
      temperature: 0.2,
      maxTokens: 8192,
      limits: DEFAULT_RUN_LIMITS,
    },
    clock,
    providers: { scripted: provider },
    approvalsPolicy: 'eval-auto',
  };
  return { deps: d, provider, clock };
}

const meta = (runId: string, scenarioId: string, mode: RunMeta['mode'], pairedRunId: string): RunMeta => ({
  runId,
  scenarioId,
  scenarioTitle: 'Reported incident',
  mode,
  status: 'created',
  createdAt: new Date(0).toISOString(),
  simMinute: 0,
  lastSeq: 0,
  totals: { inputTokens: 0, outputTokens: 0, costUsd: 0, toolCalls: 0, iterations: 0, wallMs: 0 },
  speed: 30,
  pairedRunId,
  preparing: true,
});

const OTHER = {
  text: ASH,
  mode: 'other' as const,
  network: { seed: SEED, date: DATE, flightId: flight.flight },
};

describe('"Something else": neutral base + authored incident layer', () => {
  it('the neutral base carries no template incident (no fumes, no twists, no commander decision)', () => {
    const b = base();
    expect(validateScenario(b).ok).toBe(true);
    expect(JSON.stringify(b)).not.toMatch(FUMES);
    expect(b.twists).toEqual([]);
    expect(b.trigger.evidence).toEqual([]);
    expect(b.title).toBe(`Reported incident: ${flight.flight}`);
    expect(b.airborne?.flight).toBe(flight.flight);
  });

  it('a scripted Author patch turns it into an airspace closure over many flights; both runs see it', async () => {
    const b = base();
    const patch = closurePatch(b);
    const seenRequests: string[] = [];
    const { deps: d, provider } = deps((req, info) => {
      if (info.agentPath === 'author/patch') {
        seenRequests.push(JSON.stringify(req.messages));
        return step('Patch.', call('propose_scenario_patch', patch as Record<string, unknown>));
      }
      return step('noop');
    });
    await d.store.putScenario(b);
    await d.store.createRun(meta('run-agent', b.id, 'agent', 'run-base'));
    await d.store.createRun(meta('run-base', b.id, 'baseline', 'run-agent'));
    const [pa, pb] = await Promise.all([
      prepareRunScenario((await d.store.getRun('run-agent'))!, OTHER, d, {
        registry: defaultRegistry(),
        loadScenario: (id) => d.store.getScenario(id),
        log: () => undefined,
      }),
      prepareRunScenario((await d.store.getRun('run-base'))!, undefined, d, {
        loadScenario: (id) => d.store.getScenario(id),
        log: () => undefined,
      }),
    ]);
    expect(pa).toEqual({ proceed: true });
    expect(pb).toEqual({ proceed: true });
    // The description reached the Author as data, with the network slice; the output bound is the larger one.
    expect(seenRequests[0]).toContain('volcano eruption');
    expect(seenRequests[0]).toContain('Network slice at');
    expect(provider.calls[0]?.req.maxTokens).toBe(AUTHORING_OTHER_MAX_TOKENS);

    const s = (await d.store.getScenario(b.id))!;
    expect(s.trigger).toMatchObject({ type: 'airspace-closure', scope: 'network' });
    expect(s.title).toMatch(/UK airspace closed/);
    expect(JSON.stringify(s)).not.toMatch(FUMES);
    const nNet = patch.network!.flights.length;
    expect(s.world.airborneFlights?.length).toBe(
      patch.network!.flights.filter((f) => f.effect === 'divert').length,
    );
    const occ = seedOcc(s);
    expect(Object.keys(occ.airborne).length).toBe(1 + (s.world.airborneFlights?.length ?? 0));
    for (const f of patch.network!.flights) expect(occ.flights[f.flight]).toBeDefined();
    // A network-wide event raises no defect on the incident aircraft.
    const mne = seedMne(s);
    expect(mne.aircraft[s.aircraft.tail]?.status).toBe('serviceable');
    expect(Object.keys(mne.defects)).toEqual([]);
    // The commander's decision is a scenario twist (a human decision), turning back to the departure airport.
    const cmd = s.twists.find((x) => x.id === 'tw-commander-decision')!;
    expect(cmd.title).toBe(`Commander: returning to ${flight.from}`);

    for (const id of ['run-agent', 'run-base']) {
      const events = (await d.store.listEvents(id, 0, 1000)).events;
      for (const e of events) expect(validateEvent(e).ok).toBe(true);
      const auth = ofType(events, 'scenario.authoring').at(-1)!;
      expect(auth.payload.status).toBe('patched');
      expect(auth.payload.detail).toBe(AUTHORING_COPY.authored);
      expect(auth.payload.summary).toMatchObject({ triggerType: 'airspace-closure', network: true });
      expect(auth.payload.summary!.affectedFlights).toBeGreaterThanOrEqual(1 + nNet);
      expect(foldEvents(events).meta.authoring?.summary?.network).toBe(true);
      expect((await d.store.getRun(id))?.preparing).toBe(false);
    }
  });

  it('validation rejects flights outside the day network slice and a missing incident layer', () => {
    const b = base();
    const slice = authoringSlice(OTHER, b)!;
    const patch = closurePatch(b);
    const ok = checkScenarioPatch(b, patch, defaultRegistry(), undefined, { mode: 'other', slice });
    expect(ok.ok ? [] : ok.errors).toEqual([]);
    const bad = {
      ...patch,
      network: { flights: [{ flight: 'ACX999', effect: 'hold', minutes: 60 }] },
    };
    const r = checkScenarioPatch(b, bad, defaultRegistry(), undefined, { mode: 'other', slice });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.errors.join(' ')).toMatch(/ACX999 is not in the day's network slice/);
    const noLayer = checkScenarioPatch(b, { title: 'Ash' }, defaultRegistry(), undefined, {
      mode: 'other',
      slice,
    });
    expect(!noLayer.ok && noLayer.errors.join(' ')).toMatch(/replaceTrigger is required/);
    // Free text may not name a flight the patch does not bring in.
    const invented = checkScenarioPatch(
      b,
      { ...patch, replaceNarrative: 'ACX777 is affected too.' },
      defaultRegistry(),
      undefined,
      { mode: 'other', slice },
    );
    expect(!invented.ok && invented.errors.join(' ')).toMatch(/ACX777/);
  });

  it('when authoring fails, both runs end as failed-for-authoring and no template ever runs', async () => {
    const b = base();
    const { deps: d } = deps(async (_req, info) =>
      info.agentPath === 'author/patch'
        ? { error: new LlmHttpError('scripted', 400, 'unavailable') }
        : step('should never run'),
    );
    await d.store.putScenario(b);
    await d.store.createRun(meta('run-agent', b.id, 'agent', 'run-base'));
    await d.store.createRun(meta('run-base', b.id, 'baseline', 'run-agent'));
    const opts = { registry: defaultRegistry(), log: () => undefined };
    const [agent, baseline] = await Promise.all([
      executeRunWith({ runId: 'run-agent', deps: d, authoring: OTHER }, opts),
      executeRunWith({ runId: 'run-base', deps: d }, opts),
    ]);
    expect(agent.status).toBe('failed');
    expect(baseline.status).toBe('failed');
    for (const id of ['run-agent', 'run-base']) {
      const m = (await d.store.getRun(id))!;
      expect(m.status).toBe('failed');
      expect(m.preparing).toBe(false);
      expect(m.error).toBe(AUTHORING_COPY.failed);
      const events = (await d.store.listEvents(id, 0, 1000)).events;
      const types = events.map((e) => e.type);
      expect(types).not.toContain('run.started');
      expect(ofType(events, 'scenario.authoring').at(-1)?.payload.status).toBe('failed');
      expect(ofType(events, 'run.failed')[0]?.payload).toMatchObject({ where: 'scenario.authoring' });
      expect(foldEvents(events).meta.status).toBe('failed');
    }
    // The stored scenario is still the neutral base: nothing unrelated was substituted.
    expect(await d.store.getScenario(b.id)).toEqual(b);
  });

  it('"Something else" gets the larger time bound', () => {
    expect(AUTHORING_OTHER_TIMEOUT_MS).toBe(60_000);
    expect(AUTHORING_OTHER_MAX_TOKENS).toBe(4096);
  });

  it('the Run Lambda accepts the mode and network reference and drops malformed ones', () => {
    expect(parseAuthoring({ ...OTHER, label: 'x' })).toEqual({ ...OTHER, label: 'x' });
    expect(parseAuthoring({ text: 'x', mode: 'weird', network: { seed: 1 } })).toEqual({ text: 'x' });
  });
});

describe('typed incident with contradicting details', () => {
  it('removes and replaces the template content the description contradicts', async () => {
    const built = buildScenarioFromFlight(schedule, flight.flight, 'diversion_technical', { atMs: AT });
    const template = { ...built.scenario, id: `${built.scenario.id}-t002` };
    expect(template.twists.map((x) => x.id)).toContain('tw-smell-history');
    const patch: ScenarioPatch = {
      removeTwistIds: ['tw-smell-history'],
      replaceNarrative: `On Accent Air ${flight.flight} a pressurisation fault (no smoke, no smell) leads the crew to descend; the commander diverts.`,
      replaceTrigger: {
        description: 'Cabin altitude warning; the crew descend.',
        evidence: [{ kind: 'techlog', text: 'CAB PR SYS 1 fault' }],
      },
      commanderDecision: {
        atMinute: 3,
        decision: 'divert',
        airport: template.aircraft.station,
        squawk: 'pan',
        note: 'PAN, pressurisation fault, diverting.',
      },
    };
    const { deps: d } = deps(() =>
      step('Patch.', call('propose_scenario_patch', patch as Record<string, unknown>)),
    );
    const r = await authorScenarioPatch(template, 'No fumes at all: it is a pressurisation fault.', d, {
      registry: defaultRegistry(),
    });
    expect(r.status).toBe('patched');
    const s = r.status === 'patched' ? r.scenario : template;
    expect(s.twists.map((x) => x.id)).not.toContain('tw-smell-history');
    const cmd = s.twists.find((x) => x.id === 'tw-commander-decision')!;
    expect(JSON.stringify(cmd)).toContain('pressurisation fault');
    expect(JSON.stringify(cmd)).not.toMatch(FUMES);
    expect(s.trigger.evidence).toEqual(patch.replaceTrigger!.evidence);
    expect(s.narrative).toBe(patch.replaceNarrative);
  });

  it('holds a typed patch to the small twist bound', () => {
    const built = buildScenarioFromFlight(schedule, flight.flight, 'diversion_technical', { atMs: AT });
    const tw = { title: 'x', description: 'y', effects: [{ op: 'info', text: 'z' }] };
    const r = checkScenarioPatch(built.scenario, { twists: [tw, tw, tw, tw] }, defaultRegistry());
    expect(!r.ok && r.errors.join(' ')).toMatch(/at most 3 extra twists/);
  });
});
