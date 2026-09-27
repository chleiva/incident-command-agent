/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Test doubles for the task 03 registries: three small fake systems (mne, engineers, pss) plus plain occ seed data,
 * seven fake tools covering all three tiers, fake roles and an in-memory knowledge index. The runtime consumes them
 * through the same `Registry` shape as the real `domainTools`/`systems`/`seedAll`/`roles`.
 */
import {
  AGENT_ROLES,
  AgentReportSchema,
  emptySystemState,
  validateScenario,
  type AgentRole,
  type JSONSchema,
  type KnowledgeHit,
  type KnowledgeIndex,
  type MockSystem,
  type RoleDefinition,
  type Scenario,
  type SystemState,
  type ToolDefinition,
} from '@ica/schema';
import type { Registry } from '../registry';

const obj = (properties: Record<string, unknown>, required: string[]): JSONSchema => ({
  type: 'object',
  additionalProperties: false,
  required,
  properties,
});

// ------------------------------------------------------------------ systems
export const fakeMne: MockSystem<'mne'> = {
  name: 'mne',
  seed(s) {
    const st = emptySystemState().mne;
    st.aircraft[s.aircraft.tail] = {
      tail: s.aircraft.tail,
      type: s.aircraft.type,
      station: s.aircraft.station,
      status: 'unserviceable',
      ...(s.aircraft.stand ? { stand: s.aircraft.stand } : {}),
    };
    st.defects['d-1'] = {
      id: 'd-1',
      tail: s.aircraft.tail,
      description: s.trigger.description,
      status: 'open',
      raisedAtMinute: s.trigger.atMinute,
    };
    return st;
  },
  tick: () => [],
  knownRefs: (st) => ({ tail: Object.keys(st.mne.aircraft), defect: Object.keys(st.mne.defects) }),
};

export const fakeEngineers: MockSystem<'engineers'> = {
  name: 'engineers',
  seed(s) {
    const st = emptySystemState().engineers;
    for (const e of s.world.engineers) {
      st.engineers[e.id] = {
        id: e.id,
        name: e.name,
        station: e.station,
        licence: e.licence,
        skills: e.skills,
        status: 'available',
        location: e.station,
      };
    }
    return st;
  },
  tick(state, simMinute) {
    return Object.values(state.engineers.engineers)
      .filter((e) => e.status === 'travelling' && (e.etaMinute ?? Infinity) <= simMinute)
      .map((e) => ({
        system: 'engineers' as const,
        entity: 'engineers',
        id: e.id,
        op: 'update' as const,
        before: { ...e },
        after: { ...e, status: 'on_site', location: e.destination ?? e.station },
      }));
  },
  knownRefs: (st) => ({ engineer: Object.keys(st.engineers.engineers) }),
};

export const fakePss: MockSystem<'pss'> = {
  name: 'pss',
  seed(s) {
    const st = emptySystemState().pss;
    for (const c of s.world.cohorts) {
      st.cohorts[c.id] = {
        id: c.id,
        kind: c.kind,
        count: c.count,
        flight: c.flight,
        status: 'uninformed',
        careIssued: 0,
      };
    }
    return st;
  },
  tick: () => [],
  knownRefs: (st) => ({ cohort: Object.keys(st.pss.cohorts) }),
};

export function fakeSeedAll(s: Scenario, rng: () => number): SystemState {
  const st = emptySystemState();
  st.mne = fakeMne.seed(s, rng);
  st.engineers = fakeEngineers.seed(s, rng);
  st.pss = fakePss.seed(s, rng);
  for (const leg of s.world.rotation) {
    st.occ.flights[leg.flight] = {
      flight: leg.flight,
      tail: leg.tail,
      from: leg.from,
      to: leg.to,
      std: leg.std,
      sta: leg.sta,
      status: 'scheduled',
      delayMin: 0,
      reactionaryDelayMin: 0,
      pax: leg.pax,
    };
  }
  return st;
}

// ------------------------------------------------------------------ tools
export const getAircraftStatus: ToolDefinition = {
  name: 'get_aircraft_status',
  description: 'Read the aircraft status.',
  inputSchema: obj({ tail: { type: 'string' } }, ['tail']),
  tier: 'execute',
  system: 'mne',
  roles: ['maintenance'],
  mutates: false,
  refs: [{ path: '/tail', kind: 'tail' }],
  async handler(input: { tail: string }, ctx) {
    return { ok: true, data: ctx.state.mne.aircraft[input.tail] };
  },
};

export const pageEngineer: ToolDefinition = {
  name: 'page_engineer',
  description: 'Page an engineer to the aircraft.',
  inputSchema: obj({ engineerId: { type: 'string' }, station: { type: 'string', pattern: '^[A-Z]{3}$' } }, [
    'engineerId',
    'station',
  ]),
  tier: 'execute',
  system: 'engineers',
  roles: ['maintenance'],
  mutates: true,
  refs: [{ path: '/engineerId', kind: 'engineer' }],
  async handler(input: { engineerId: string; station: string }, ctx) {
    const e = ctx.state.engineers.engineers[input.engineerId];
    if (e.status !== 'available') return { ok: false, error: `engineer ${e.id} is ${e.status}` };
    const after = {
      ...e,
      status: 'travelling',
      etaMinute: ctx.simMinute + 5,
      destination: input.station,
      travelMode: 'walk',
    };
    return {
      ok: true,
      data: { engineerId: e.id, etaMinute: after.etaMinute },
      mutations: [
        { system: 'engineers', entity: 'engineers', id: e.id, op: 'update', before: { ...e }, after },
      ],
    };
  },
};

export const createWorkOrder: ToolDefinition = {
  name: 'create_work_order',
  description: 'Create a work order.',
  inputSchema: obj(
    {
      tail: { type: 'string' },
      task: { type: 'string', maxLength: 200 },
      estimatedDurationMin: { type: 'integer', minimum: 1, maximum: 600 },
    },
    ['tail', 'task', 'estimatedDurationMin'],
  ),
  tier: 'execute',
  system: 'mne',
  roles: ['maintenance'],
  mutates: true,
  refs: [{ path: '/tail', kind: 'tail' }],
  async handler(input: { tail: string; task: string; estimatedDurationMin: number }, ctx) {
    const id = `wo-${Object.keys(ctx.state.mne.workOrders).length + 1}`;
    const after = {
      id,
      tail: input.tail,
      task: input.task,
      status: 'created',
      createdAtMinute: ctx.simMinute,
      estimatedDurationMin: input.estimatedDurationMin,
      progressPct: 0,
    };
    return {
      ok: true,
      data: { id },
      mutations: [{ system: 'mne', entity: 'workOrders', id, op: 'create', after }],
    };
  },
};

export const searchMel: ToolDefinition = {
  name: 'search_mel',
  description: 'Search the MEL.',
  inputSchema: obj({ query: { type: 'string', minLength: 1 } }, ['query']),
  tier: 'execute',
  system: 'knowledge',
  roles: ['maintenance'],
  mutates: false,
  async handler(input: { query: string }, ctx) {
    const hits = await ctx.knowledge.search({ query: input.query, collections: ['mel'], k: 2 });
    return {
      ok: true,
      data: hits.map((h) => ({ chunkId: h.chunkId, text: h.text })),
      citations: hits.map((h) => ({
        sourceId: h.sourceId,
        url: h.url,
        title: h.title,
        quote: h.text.slice(0, 200),
        chunkId: h.chunkId,
      })),
    };
  },
};

export const sendPassengerMessage: ToolDefinition = {
  name: 'send_passenger_message',
  description: 'Send a message to passenger cohorts (needs approval).',
  inputSchema: obj(
    {
      cohortIds: { type: 'array', minItems: 1, items: { type: 'string' } },
      channel: { type: 'string', enum: ['sms', 'email', 'app'] },
      body: { type: 'string', minLength: 1, maxLength: 640 },
    },
    ['cohortIds', 'channel', 'body'],
  ),
  tier: 'propose',
  system: 'pss',
  roles: ['passenger'],
  mutates: true,
  outputScreen: { kind: 'passenger_message', fields: ['/body'] },
  refs: [{ path: '/cohortIds', kind: 'cohort' }],
  async handler(input: { cohortIds: string[]; channel: 'sms'; body: string }, ctx) {
    const id = `msg-${Object.keys(ctx.state.pss.messages).length + 1}`;
    const msg = {
      id,
      cohortIds: input.cohortIds,
      channel: input.channel,
      body: input.body,
      status: 'sent',
      aiDrafted: true,
      sentAtMinute: ctx.simMinute,
      approvedBy: ctx.approvedBy ?? ctx.actor,
    };
    const cohortMuts = input.cohortIds.map((cid) => {
      const c = ctx.state.pss.cohorts[cid];
      return {
        system: 'pss' as const,
        entity: 'cohorts',
        id: cid,
        op: 'update' as const,
        before: { ...c },
        after: { ...c, status: 'informed', firstInformedAtMinute: c.firstInformedAtMinute ?? ctx.simMinute },
      };
    });
    return {
      ok: true,
      data: { id, sentAtMinute: ctx.simMinute },
      mutations: [{ system: 'pss', entity: 'messages', id, op: 'create', after: msg }, ...cohortMuts],
    };
  },
};

export const proposeSwap: ToolDefinition = {
  name: 'propose_swap',
  description: 'Swap the flights to a spare aircraft (needs approval).',
  inputSchema: obj(
    {
      fromTail: { type: 'string' },
      toTail: { type: 'string' },
      flights: { type: 'array', items: { type: 'string' } },
    },
    ['fromTail', 'toTail', 'flights'],
  ),
  tier: 'propose',
  system: 'occ',
  roles: ['flightops'],
  mutates: true,
  async handler(input: { fromTail: string; toTail: string; flights: string[] }, ctx) {
    const id = `swap-${Object.keys(ctx.state.occ.swaps).length + 1}`;
    const after = { id, ...input, status: 'approved', approvedBy: ctx.approvedBy ?? ctx.actor };
    return {
      ok: true,
      data: { id },
      mutations: [{ system: 'occ', entity: 'swaps', id, op: 'create', after }],
    };
  },
};

export const deferDefect: ToolDefinition = {
  name: 'defer_defect',
  description: 'Defer a defect under the MEL (certifying staff only).',
  inputSchema: obj({ defectId: { type: 'string' }, melItem: { type: 'string' } }, ['defectId', 'melItem']),
  tier: 'forbidden',
  system: 'mne',
  roles: ['maintenance'],
  mutates: true,
  async handler(input: { defectId: string; melItem: string }, ctx) {
    if (ctx.actor.kind !== 'human' || !/certifying/i.test(ctx.actor.roleTitle)) {
      return { ok: false, error: 'only certifying staff may defer' };
    }
    const d = ctx.state.mne.defects[input.defectId];
    const after = { ...d, status: 'deferred', melItem: input.melItem, deferredBy: ctx.actor };
    return {
      ok: true,
      data: { deferred: true },
      mutations: [{ system: 'mne', entity: 'defects', id: d.id, op: 'update', after }],
    };
  },
};

export const validateScenarioTool: ToolDefinition = {
  name: 'validate_scenario',
  description: 'Validate a scenario JSON.',
  inputSchema: obj({ scenario: { type: 'object' } }, ['scenario']),
  tier: 'execute',
  system: 'knowledge',
  roles: ['author'],
  mutates: false,
  async handler(input: { scenario: unknown }) {
    const r = validateScenario(input.scenario);
    return { ok: true, data: r.ok ? { valid: true } : { valid: false, errors: r.errors.slice(0, 20) } };
  },
};

export const fakeTools: ToolDefinition[] = [
  getAircraftStatus,
  pageEngineer,
  createWorkOrder,
  searchMel,
  sendPassengerMessage,
  proposeSwap,
  deferDefect,
  validateScenarioTool,
];

// ------------------------------------------------------------------ roles
const ROLE_TOOLS: Record<AgentRole, string[]> = {
  orchestrator: [],
  maintenance: ['get_aircraft_status', 'page_engineer', 'create_work_order', 'search_mel', 'defer_defect'],
  ground: [],
  flightops: ['propose_swap'],
  passenger: ['send_passenger_message'],
  record: [],
  author: ['validate_scenario'],
};

const authorReportSchema: JSONSchema = {
  type: 'object',
  required: ['summary', 'actionsTaken', 'openIssues', 'recommendations', 'citations', 'scenario'],
  properties: {
    ...(JSON.parse(JSON.stringify(AgentReportSchema)) as { properties: Record<string, unknown> }).properties,
    scenario: { type: 'object' },
  },
};

export const fakeRoles = Object.fromEntries(
  AGENT_ROLES.map((role): [AgentRole, RoleDefinition] => [
    role,
    {
      role,
      title: `Fake ${role}`,
      systemPrompt: `Fake constant prompt for ${role}.`,
      tools: ROLE_TOOLS[role],
      reportSchema: role === 'author' ? authorReportSchema : (AgentReportSchema as unknown as JSONSchema),
      stop: 'report_tool',
    },
  ]),
) as Record<AgentRole, RoleDefinition>;

// ------------------------------------------------------------------ knowledge
export const FAKE_HITS: KnowledgeHit[] = [
  {
    chunkId: 'mel-52-1',
    sourceId: 'FAA-A320-MMEL',
    url: 'https://www.faa.gov/',
    title: 'A320 MMEL — Doors',
    section: '52',
    collection: 'mel',
    text: 'Cargo door indication may be inoperative provided the door is verified closed and locked before each departure.',
    score: 1,
  },
  {
    chunkId: 'pr-1',
    sourceId: 'EU261',
    url: 'https://eur-lex.europa.eu/',
    title: 'Regulation (EC) No 261/2004',
    collection: 'passenger_rights',
    jurisdiction: 'EU',
    text: 'Passengers shall be offered meals and refreshments in reasonable relation to the waiting time.',
    score: 1,
  },
];

export function fakeKnowledge(extra: KnowledgeHit[] = []): KnowledgeIndex {
  const all = [...extra, ...FAKE_HITS];
  return {
    async search(q) {
      return all.filter((h) => !q.collections || q.collections.includes(h.collection)).slice(0, q.k ?? 5);
    },
  };
}

export function fakeRegistry(overrides: Partial<Registry> = {}): Registry {
  return {
    tools: fakeTools,
    systems: [fakeMne, fakeEngineers, fakePss],
    seedAll: fakeSeedAll,
    roles: fakeRoles,
    ...overrides,
  };
}
