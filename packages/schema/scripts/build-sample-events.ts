/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Builds fixtures/run.sample.events.json: a coherent ~60-event run over fixtures/scenario.minimal.json.
 * Deterministic (fixed ids and wall times). Re-run with `npm run -w @ica/schema gen` after contract changes.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_RUN_LIMITS,
  type Actor,
  type AgentRole,
  type EventPayloadMap,
  type EventType,
  type KpiSnapshot,
  type RunEvent,
  type Scenario,
  type Usage,
} from '../src/index';

const scenario = JSON.parse(
  readFileSync(fileURLToPath(new URL('../fixtures/scenario.minimal.json', import.meta.url)), 'utf8'),
) as Scenario;

const RUN_ID = 'run-fixture-0001';
const start = Date.parse(scenario.startSimTime);
const wallStart = Date.parse('2026-06-01T09:00:00Z');
const events: RunEvent[] = [];

const agent = (role: AgentRole): Actor => ({ kind: 'agent', role });
const WORLD: Actor = { kind: 'world' };
const DUTY: Actor = { kind: 'human', name: 'Sam Okafor', roleTitle: 'Duty Manager' };

const ORCH = 'ar-orch-1';
const MX = 'ar-mx-1';
const PAX = 'ar-pax-1';

function usage(inputTokens: number, outputTokens: number, cacheReadTokens = 0): Usage {
  // Sonnet 5 list prices (config/pricing.json): $2 in, $10 out, $0.2 cache read per MTok.
  const costUsd = +((inputTokens * 2 + outputTokens * 10 + cacheReadTokens * 0.2) / 1e6).toFixed(6);
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens: 0,
    costUsd,
    model: 'claude-sonnet-5',
    provider: 'anthropic',
  };
}

function push<T extends EventType>(
  type: T,
  simMinute: number,
  actor: Actor,
  payload: EventPayloadMap[T],
  extra: {
    agentRunId?: string;
    parentAgentRunId?: string;
    iteration?: number;
    usage?: Usage;
    latencyMs?: number;
  } = {},
): RunEvent<T> {
  const seq = events.length + 1;
  const e = {
    runId: RUN_ID,
    seq,
    type,
    actor,
    ...extra,
    simMinute,
    simTime: new Date(start + simMinute * 60_000).toISOString(),
    wallTime: new Date(wallStart + seq * 2_000).toISOString(),
    ...(extra.usage ? { traceKey: `traces/${RUN_ID}/${seq}.json` } : {}),
    payload,
  } as unknown as RunEvent<T>;
  events.push(e);
  return e;
}

function kpis(
  simMinute: number,
  o: { delayMin: number; satisfaction: number; paxMsg: number | null; seqs: number[]; forbidden: number },
): KpiSnapshot {
  const delayCost = o.delayMin * 100 + o.delayMin * 0.5 * 1.8 * 100;
  return {
    simMinute,
    incidentClockMin: Math.max(0, simMinute - scenario.trigger.atMinute),
    minutesTo3h: 180 - o.delayMin,
    delayCostEur: {
      value: delayCost,
      formula: 'primary min × €/min + reactionary min × factor × €/min',
      inputs: {
        primaryMin: o.delayMin,
        reactionaryMin: o.delayMin * 0.5,
        eurPerMinute: 100,
        reactionaryFactor: 1.8,
      },
      contributingSeqs: o.seqs,
    },
    eu261ExposureEur: {
      value: 0,
      formula: 'pax × tier when projected delay ≥ 3 h, plus care by elapsed hours',
      inputs: { pax: 162, tierEur: 250, projectedDelayMin: o.delayMin },
      contributingSeqs: [],
    },
    cancellationCostEur: {
      value: 0,
      formula: 'fixed + rebooking + accommodation (if cancelled)',
      inputs: { cancelled: false },
      contributingSeqs: [],
    },
    totalCostEur: {
      value: delayCost,
      formula: 'delay + EU261 + cancellation',
      inputs: { delayCostEur: delayCost },
      contributingSeqs: o.seqs,
    },
    satisfaction: {
      value: o.satisfaction,
      formula: '100 − 0.8/min uninformed + 8 first message + 5/care + 10 rebooked < 3 h − 15 cancel',
      inputs: { uninformedMin: o.paxMsg ?? simMinute, firstMessageMin: o.paxMsg },
      contributingSeqs: o.seqs,
    },
    compliance: {
      value: {
        art14NoticeIssued: o.paxMsg !== null,
        reroutingOfferedWithin3h: null,
        fdpRespected: true,
        morDraftedWithin72h: false,
        threeHourThresholdAvoided: null,
      },
      formula: 'booleans per EU261 Art 14, FTL and Reg. 376/2014',
      inputs: { firstPaxMessageMin: o.paxMsg },
      contributingSeqs: o.seqs,
    },
    safety: {
      value: {
        forbiddenAttempts: o.forbidden,
        humanDecisionsBeforeDependentActions: 0,
        dependentActionsWithoutDecision: 0,
      },
      formula: 'count of forbidden tool attempts; human decisions recorded before dependent actions',
      inputs: { forbiddenAttempts: o.forbidden },
      contributingSeqs: [],
    },
    latency: {
      value: {
        firstEngineeringDecisionMin: null,
        firstPaxMessageMin: o.paxMsg,
        swapOrCancelDecisionMin: null,
      },
      formula: 'sim minutes from trigger to first decision/message',
      inputs: {},
      contributingSeqs: o.seqs,
    },
  };
}

// ---------------------------------------------------------------------------------------------- the story
push('run.created', 0, DUTY, {
  scenarioId: scenario.id,
  mode: 'agent',
  speed: 6,
  config: { provider: 'anthropic', model: 'claude-sonnet-5', limits: DEFAULT_RUN_LIMITS },
});
push('run.started', 0, WORLD, { speed: 6 });

// seed mutations
const aircraft = { tail: 'AX-FXA', type: 'A320', station: 'MAN', status: 'serviceable', stand: '22' };
push('system.mutation', 0, WORLD, {
  system: 'mne',
  entity: 'aircraft',
  id: 'AX-FXA',
  op: 'create',
  after: aircraft,
});
push('system.mutation', 0, WORLD, {
  system: 'occ',
  entity: 'flights',
  id: 'ACX101',
  op: 'create',
  after: {
    flight: 'ACX101',
    tail: 'AX-FXA',
    from: 'MAN',
    to: 'DUB',
    std: '2026-06-12T06:10:00Z',
    sta: '2026-06-12T07:10:00Z',
    status: 'boarding',
    delayMin: 0,
    reactionaryDelayMin: 0,
    pax: 162,
  },
});
push('system.mutation', 0, WORLD, {
  system: 'occ',
  entity: 'spares',
  id: 'AX-FXB',
  op: 'create',
  after: { tail: 'AX-FXB', type: 'A320', station: 'MAN', availableFromMinute: 45 },
});
push('system.mutation', 0, WORLD, {
  system: 'pss',
  entity: 'cohorts',
  id: 'c-connections',
  op: 'create',
  after: {
    id: 'c-connections',
    kind: 'connections',
    count: 18,
    flight: 'ACX101',
    status: 'uninformed',
    careIssued: 0,
    onwardDeadline: '2026-06-12T08:30:00Z',
  },
});
push('system.mutation', 0, WORLD, {
  system: 'pss',
  entity: 'cohorts',
  id: 'c-prm',
  op: 'create',
  after: { id: 'c-prm', kind: 'prm', count: 4, flight: 'ACX101', status: 'uninformed', careIssued: 0 },
});
const eng1 = {
  id: 'eng-1',
  name: 'Ada Pennick',
  station: 'MAN',
  licence: 'B1',
  skills: ['A320', 'doors'],
  status: 'available',
  location: 'MAN',
};
push('system.mutation', 0, WORLD, {
  system: 'engineers',
  entity: 'engineers',
  id: 'eng-1',
  op: 'create',
  after: eng1,
});
push('system.mutation', 0, WORLD, {
  system: 'engineers',
  entity: 'engineers',
  id: 'eng-2',
  op: 'create',
  after: {
    id: 'eng-2',
    name: 'Tomas Wrenfield',
    station: 'MAN',
    licence: 'B2',
    skills: ['A320', 'avionics'],
    status: 'busy',
    location: 'MAN',
  },
});
const k1 = push(
  'kpi.update',
  0,
  WORLD,
  kpis(0, { delayMin: 0, satisfaction: 100, paxMsg: null, seqs: [], forbidden: 0 }),
);

// trigger → defect
push('world.process', 2, WORLD, {
  system: 'mne',
  entity: 'defects',
  id: 'def-1',
  change: 'defect raised from trigger',
});
push('system.mutation', 2, WORLD, {
  system: 'mne',
  entity: 'defects',
  id: 'def-1',
  op: 'create',
  after: {
    id: 'def-1',
    tail: 'AX-FXA',
    description: 'Intermittent FWD CARGO DOOR caution',
    ata: '52',
    status: 'open',
    raisedAtMinute: 2,
  },
});

// orchestrator
push(
  'agent.started',
  2,
  agent('orchestrator'),
  { role: 'orchestrator', brief: 'Coordinate the response to the scenario.' },
  { agentRunId: ORCH },
);
push(
  'agent.thought',
  2.2,
  agent('orchestrator'),
  {
    text: 'A door caution during boarding needs an engineer and early passenger information. I will open the incident and brief maintenance and passenger agents in parallel.',
    summary: 'A door caution during boarding needs an engineer and early passenger information.',
  },
  { agentRunId: ORCH, iteration: 1, usage: usage(5200, 310, 3800), latencyMs: 2100 },
);
push(
  'agent.tool_call',
  2.3,
  agent('orchestrator'),
  {
    toolCallId: 'tc-1',
    tool: 'open_incident',
    system: 'runtime',
    tier: 'execute',
    args: { title: 'AX-FXA FWD cargo door caution', severity: 'medium' },
  },
  { agentRunId: ORCH, iteration: 1 },
);
push('system.mutation', 2.3, agent('orchestrator'), {
  system: 'record',
  entity: 'timeline',
  id: 'tl-1',
  op: 'create',
  after: {
    id: 'tl-1',
    atMinute: 2.3,
    text: 'Incident opened: AX-FXA FWD cargo door caution',
    source: 'orchestrator',
  },
});
push(
  'agent.tool_result',
  2.3,
  agent('orchestrator'),
  { toolCallId: 'tc-1', tool: 'open_incident', ok: true, resultPreview: '{"incidentId":"inc-1"}' },
  { agentRunId: ORCH, iteration: 1 },
);
push(
  'agent.tool_call',
  2.4,
  agent('orchestrator'),
  {
    toolCallId: 'tc-2',
    tool: 'delegate',
    system: 'runtime',
    tier: 'execute',
    args: {
      role: 'maintenance',
      brief: 'Assess the FWD cargo door caution on AX-FXA and get an engineer to the aircraft.',
    },
  },
  { agentRunId: ORCH, iteration: 1 },
);
push(
  'agent.tool_call',
  2.4,
  agent('orchestrator'),
  {
    toolCallId: 'tc-3',
    tool: 'delegate',
    system: 'runtime',
    tier: 'execute',
    args: { role: 'passenger', brief: 'Inform ACX101 passengers early; PRM and connections first.' },
  },
  { agentRunId: ORCH, iteration: 1 },
);

// maintenance specialist
push(
  'agent.started',
  2.5,
  agent('maintenance'),
  {
    role: 'maintenance',
    brief: 'Assess the FWD cargo door caution on AX-FXA and get an engineer to the aircraft.',
    parentAgentRunId: ORCH,
  },
  { agentRunId: MX, parentAgentRunId: ORCH },
);
push(
  'agent.started',
  2.5,
  agent('passenger'),
  {
    role: 'passenger',
    brief: 'Inform ACX101 passengers early; PRM and connections first.',
    parentAgentRunId: ORCH,
  },
  { agentRunId: PAX, parentAgentRunId: ORCH },
);
push(
  'agent.thought',
  2.8,
  agent('maintenance'),
  {
    text: 'Check aircraft status and the MEL before paging an engineer.',
    summary: 'Check aircraft status and the MEL before paging an engineer.',
  },
  { agentRunId: MX, parentAgentRunId: ORCH, iteration: 1, usage: usage(3900, 220, 2900), latencyMs: 1800 },
);
push(
  'agent.tool_call',
  2.9,
  agent('maintenance'),
  {
    toolCallId: 'tc-4',
    tool: 'get_aircraft_status',
    system: 'mne',
    tier: 'execute',
    args: { tail: 'AX-FXA' },
  },
  { agentRunId: MX, parentAgentRunId: ORCH, iteration: 1 },
);
push(
  'agent.tool_result',
  2.9,
  agent('maintenance'),
  {
    toolCallId: 'tc-4',
    tool: 'get_aircraft_status',
    ok: true,
    resultPreview: '{"tail":"AX-FXA","status":"serviceable","openDefects":["def-1"]}',
    result: { tail: 'AX-FXA', status: 'serviceable', openDefects: ['def-1'] },
  },
  { agentRunId: MX, parentAgentRunId: ORCH, iteration: 1 },
);
push(
  'agent.tool_call',
  3.1,
  agent('maintenance'),
  {
    toolCallId: 'tc-5',
    tool: 'search_mel',
    system: 'knowledge',
    tier: 'execute',
    args: { query: 'cargo door indication' },
  },
  { agentRunId: MX, parentAgentRunId: ORCH, iteration: 1 },
);
push(
  'agent.tool_result',
  3.2,
  agent('maintenance'),
  {
    toolCallId: 'tc-5',
    tool: 'search_mel',
    ok: true,
    resultPreview: '1 hit: fixture MEL chunk on cargo door indications',
    citations: [
      {
        sourceId: 'fixture-mel',
        url: 'https://example.org/fixture-mel',
        title: 'Fixture MEL excerpt',
        quote: 'Fixture text: indication items require maintenance action before dispatch.',
        chunkId: 'fixture-mel#1',
      },
    ],
  },
  { agentRunId: MX, parentAgentRunId: ORCH, iteration: 1 },
);
push(
  'agent.tool_call',
  3.4,
  agent('maintenance'),
  {
    toolCallId: 'tc-6',
    tool: 'page_engineer',
    system: 'engineers',
    tier: 'execute',
    args: { engineerId: 'eng-1', tail: 'AX-FXA' },
  },
  { agentRunId: MX, parentAgentRunId: ORCH, iteration: 2 },
);
const pageMut = push('system.mutation', 3.4, agent('maintenance'), {
  system: 'engineers',
  entity: 'engineers',
  id: 'eng-1',
  op: 'update',
  before: eng1,
  after: { ...eng1, status: 'travelling', etaMinute: 11, travelMode: 'walk', destination: 'MAN' },
});
push(
  'agent.tool_result',
  3.4,
  agent('maintenance'),
  {
    toolCallId: 'tc-6',
    tool: 'page_engineer',
    ok: true,
    resultPreview: '{"engineerId":"eng-1","etaMinute":11}',
  },
  { agentRunId: MX, parentAgentRunId: ORCH, iteration: 2 },
);
push('world.tick', 4, WORLD, { simMinute: 4 });

// passenger specialist
push(
  'agent.thought',
  4.2,
  agent('passenger'),
  {
    text: 'Draft a short, plain-language message with a time for the next update.',
    summary: 'Draft a short, plain-language message with a time for the next update.',
  },
  { agentRunId: PAX, parentAgentRunId: ORCH, iteration: 1, usage: usage(4100, 380, 2900), latencyMs: 2400 },
);
const msgDraft = {
  id: 'msg-1',
  cohortIds: ['c-connections', 'c-prm'],
  channel: 'sms',
  body: 'ACX101 to Dublin: engineers are checking a door sensor. We will update you by 06:25. Connecting passengers: our team is watching your onward times.',
  status: 'draft',
  aiDrafted: true,
};
push(
  'agent.tool_call',
  4.4,
  agent('passenger'),
  {
    toolCallId: 'tc-7',
    tool: 'draft_passenger_message',
    system: 'pss',
    tier: 'execute',
    args: { cohortIds: ['c-connections', 'c-prm'], channel: 'sms', body: msgDraft.body },
  },
  { agentRunId: PAX, parentAgentRunId: ORCH, iteration: 1 },
);
push('system.mutation', 4.4, agent('passenger'), {
  system: 'pss',
  entity: 'messages',
  id: 'msg-1',
  op: 'create',
  after: msgDraft,
});
push(
  'agent.tool_result',
  4.4,
  agent('passenger'),
  {
    toolCallId: 'tc-7',
    tool: 'draft_passenger_message',
    ok: true,
    resultPreview: '{"messageId":"msg-1","status":"draft"}',
  },
  { agentRunId: PAX, parentAgentRunId: ORCH, iteration: 1 },
);
push(
  'agent.tool_call',
  4.6,
  agent('passenger'),
  {
    toolCallId: 'tc-8',
    tool: 'send_passenger_message',
    system: 'pss',
    tier: 'propose',
    args: { messageId: 'msg-1' },
  },
  { agentRunId: PAX, parentAgentRunId: ORCH, iteration: 2 },
);
push(
  'agent.proposal',
  4.6,
  agent('passenger'),
  {
    approvalId: 'apr-1',
    toolCallId: 'tc-8',
    tool: 'send_passenger_message',
    args: { messageId: 'msg-1' },
    summary: 'Send the first update to 22 passengers (connections, PRM) by SMS.',
    reasoning:
      'Early information lifts satisfaction and meets Art 14; PRM and connecting passengers need the most lead time.',
    expiresAtMinute: 10,
    tier: 'propose',
  },
  { agentRunId: PAX, parentAgentRunId: ORCH, iteration: 2 },
);
const dec1 = push('approval.decision', 6, DUTY, {
  approvalId: 'apr-1',
  decision: 'approve',
  decidedBy: DUTY,
});
push(
  'system.mutation',
  6.1,
  agent('passenger'),
  {
    system: 'pss',
    entity: 'messages',
    id: 'msg-1',
    op: 'update',
    before: msgDraft,
    after: { ...msgDraft, status: 'sent', sentAtMinute: 6.1, approvedBy: DUTY },
  },
  { agentRunId: PAX, parentAgentRunId: ORCH },
);
push(
  'system.mutation',
  6.1,
  agent('passenger'),
  {
    system: 'pss',
    entity: 'cohorts',
    id: 'c-connections',
    op: 'update',
    after: {
      id: 'c-connections',
      kind: 'connections',
      count: 18,
      flight: 'ACX101',
      status: 'informed',
      firstInformedAtMinute: 6.1,
      careIssued: 0,
      onwardDeadline: '2026-06-12T08:30:00Z',
    },
  },
  { agentRunId: PAX, parentAgentRunId: ORCH },
);
push(
  'agent.tool_result',
  6.1,
  agent('passenger'),
  {
    toolCallId: 'tc-8',
    tool: 'send_passenger_message',
    ok: true,
    resultPreview: `approved by Sam Okafor (Duty Manager) at seq ${dec1.seq}; sent to 22 passengers`,
  },
  { agentRunId: PAX, parentAgentRunId: ORCH, iteration: 2 },
);
const k2 = push(
  'kpi.update',
  6.2,
  WORLD,
  kpis(6.2, { delayMin: 10, satisfaction: 95, paxMsg: 6.1, seqs: [dec1.seq], forbidden: 0 }),
);

// engineer arrives (modelled process)
push('world.process', 11, WORLD, {
  system: 'engineers',
  entity: 'engineers',
  id: 'eng-1',
  change: 'engineer on site',
});
push('system.mutation', 11, WORLD, {
  system: 'engineers',
  entity: 'engineers',
  id: 'eng-1',
  op: 'update',
  after: { ...eng1, status: 'on_site', location: 'MAN' },
  causedBySeq: pageMut.seq,
});

// scheduled twist
push('world.twist', 12, WORLD, {
  twistId: 'tw-engineer-delayed',
  title: 'Second engineer delayed',
  description: 'The B2 engineer is held up at another aircraft for 15 more minutes.',
  source: 'scheduled',
  effects: scenario.twists[0].effects,
});
push('system.mutation', 12, WORLD, {
  system: 'engineers',
  entity: 'engineers',
  id: 'eng-2',
  op: 'update',
  after: {
    id: 'eng-2',
    name: 'Tomas Wrenfield',
    station: 'MAN',
    licence: 'B2',
    skills: ['A320', 'avionics'],
    status: 'busy',
    location: 'MAN',
  },
});
// maintenance tries a forbidden action → blocked in code
push(
  'agent.thought',
  12.5,
  agent('maintenance'),
  {
    text: 'The indication is intermittent; a deferral could keep the schedule.',
    summary: 'The indication is intermittent; a deferral could keep the schedule.',
  },
  { agentRunId: MX, parentAgentRunId: ORCH, iteration: 3, usage: usage(6100, 190, 4800), latencyMs: 1900 },
);
push(
  'agent.tool_call',
  12.6,
  agent('maintenance'),
  { toolCallId: 'tc-9', tool: 'defer_defect', system: 'mne', tier: 'forbidden', args: { defectId: 'def-1' } },
  { agentRunId: MX, parentAgentRunId: ORCH, iteration: 3 },
);
push(
  'guardrail.blocked',
  12.6,
  WORLD,
  {
    layer: 'tier',
    tool: 'defer_defect',
    reason: 'Deferral is reserved to certifying staff; use request_decision to put the question to a human.',
    toolCallId: 'tc-9',
  },
  { agentRunId: MX, parentAgentRunId: ORCH, iteration: 3 },
);
push(
  'agent.tool_result',
  12.6,
  agent('maintenance'),
  {
    toolCallId: 'tc-9',
    tool: 'defer_defect',
    ok: false,
    resultPreview: 'blocked: deferral is reserved to certifying staff',
  },
  { agentRunId: MX, parentAgentRunId: ORCH, iteration: 3 },
);
push(
  'agent.report',
  13,
  agent('maintenance'),
  {
    role: 'maintenance',
    report: {
      summary: 'B1 engineer on site; door inspection under way. Deferral is a human decision.',
      actionsTaken: ['Paged eng-1 (on site at minute 11)', 'Checked the MEL'],
      openIssues: ['Rectify or swap decision by the certifying engineer'],
      recommendations: ['Keep AX-FXB ready as a spare from minute 45'],
      citations: [
        {
          sourceId: 'fixture-mel',
          url: 'https://example.org/fixture-mel',
          title: 'Fixture MEL excerpt',
          quote: 'Fixture text: indication items require maintenance action before dispatch.',
          chunkId: 'fixture-mel#1',
        },
      ],
    },
  },
  { agentRunId: MX, parentAgentRunId: ORCH, usage: usage(6500, 420, 5200), latencyMs: 2600 },
);
push(
  'agent.tool_result',
  13,
  agent('orchestrator'),
  {
    toolCallId: 'tc-2',
    tool: 'delegate',
    ok: true,
    resultPreview: 'maintenance: B1 engineer on site; deferral is a human decision.',
  },
  { agentRunId: ORCH, iteration: 1 },
);
push(
  'agent.report',
  13.2,
  agent('passenger'),
  {
    role: 'passenger',
    report: {
      summary: 'First message sent at minute 6 to connections and PRM.',
      actionsTaken: ['Drafted and sent msg-1 (approved)'],
      openIssues: ['General cohort still to be informed'],
      recommendations: ['Next update by 06:25'],
      citations: [],
    },
  },
  { agentRunId: PAX, parentAgentRunId: ORCH, usage: usage(5000, 300, 3900), latencyMs: 2000 },
);
push(
  'agent.tool_result',
  13.2,
  agent('orchestrator'),
  {
    toolCallId: 'tc-3',
    tool: 'delegate',
    ok: true,
    resultPreview: 'passenger: first message sent at minute 6.',
  },
  { agentRunId: ORCH, iteration: 1 },
);

// options decision
push(
  'agent.thought',
  14,
  agent('orchestrator'),
  {
    text: 'There are real alternatives: wait for rectification or swap to AX-FXB. I will ask the duty manager.',
    summary: 'There are real alternatives: wait for rectification or swap to AX-FXB.',
  },
  { agentRunId: ORCH, iteration: 2, usage: usage(9800, 640, 7400), latencyMs: 3100 },
);
push(
  'agent.tool_call',
  14.2,
  agent('orchestrator'),
  {
    toolCallId: 'tc-10',
    tool: 'request_decision',
    system: 'runtime',
    tier: 'propose',
    args: { question: 'Rectify on AX-FXA or swap to AX-FXB?', recommendedOptionId: 'opt-rectify' },
  },
  { agentRunId: ORCH, iteration: 2 },
);
push(
  'agent.proposal',
  14.2,
  agent('orchestrator'),
  {
    approvalId: 'apr-2',
    toolCallId: 'tc-10',
    tool: 'request_decision',
    args: { question: 'Rectify on AX-FXA or swap to AX-FXB?' },
    summary: 'Choose how ACX101 departs.',
    reasoning: 'Rectification is likely quick if the sensor is at fault; the spare frees up at minute 45.',
    options: [
      {
        id: 'opt-rectify',
        label: 'Rectify on AX-FXA',
        metrics: {
          timeToDepartureMin: 35,
          costEur: 6650,
          customerImpact: 25,
          compliant: true,
          constraints: ['Certifying engineer sign-off'],
        },
        recommended: true,
      },
      {
        id: 'opt-swap',
        label: 'Swap to AX-FXB',
        metrics: {
          timeToDepartureMin: 55,
          costEur: 9800,
          customerImpact: 40,
          compliant: true,
          constraints: ['Spare free from minute 45', 'Re-board passengers'],
        },
        recommended: false,
      },
      {
        id: 'opt-cancel',
        label: 'Cancel ACX101',
        metrics: {
          timeToDepartureMin: -1,
          costEur: 18600,
          customerImpact: 90,
          compliant: true,
          constraints: ['Rebook 162 passengers'],
        },
        recommended: false,
      },
    ],
    expiresAtMinute: 25,
    tier: 'propose',
  },
  { agentRunId: ORCH, iteration: 2 },
);
const dec2 = push('approval.decision', 17, DUTY, {
  approvalId: 'apr-2',
  decision: 'approve',
  selectedOptionId: 'opt-rectify',
  reason: 'Engineer on site; sensor fault likely.',
  decidedBy: DUTY,
});
push(
  'agent.tool_result',
  17.1,
  agent('orchestrator'),
  {
    toolCallId: 'tc-10',
    tool: 'request_decision',
    ok: true,
    resultPreview: 'Duty Manager selected opt-rectify',
  },
  { agentRunId: ORCH, iteration: 2 },
);
push(
  'system.mutation',
  17.1,
  agent('orchestrator'),
  {
    system: 'record',
    entity: 'timeline',
    id: 'tl-2',
    op: 'create',
    after: { id: 'tl-2', atMinute: 17.1, text: 'Duty Manager chose: rectify on AX-FXA', source: 'human' },
  },
  { agentRunId: ORCH },
);
push('world.tick', 18, WORLD, { simMinute: 18 });
const k3 = push(
  'kpi.update',
  18,
  WORLD,
  kpis(18, { delayMin: 25, satisfaction: 97, paxMsg: 6.1, seqs: [dec1.seq, dec2.seq], forbidden: 1 }),
);
push(
  'agent.report',
  19,
  agent('orchestrator'),
  {
    role: 'orchestrator',
    report: {
      summary: 'Engineer on site, passengers informed at minute 6, duty manager chose rectification.',
      actionsTaken: [
        'Opened incident',
        'Delegated maintenance and passenger work',
        'Requested a decision with three options',
      ],
      openIssues: ['Certifying engineer to decide release'],
      recommendations: ['Send the next passenger update by 06:25'],
      citations: [],
    },
  },
  { agentRunId: ORCH, usage: usage(10400, 520, 8100), latencyMs: 2800 },
);

const totals = events.reduce(
  (t, e) =>
    e.usage
      ? {
          ...t,
          inputTokens: t.inputTokens + e.usage.inputTokens,
          outputTokens: t.outputTokens + e.usage.outputTokens,
          costUsd: t.costUsd + e.usage.costUsd,
        }
      : t,
  { inputTokens: 0, outputTokens: 0, costUsd: 0 },
);
push('run.completed', 19, WORLD, {
  reason: 'report',
  totals: {
    ...totals,
    costUsd: +totals.costUsd.toFixed(6),
    toolCalls: events.filter((e) => e.type === 'agent.tool_call').length,
    iterations: events.filter((e) => e.type === 'agent.thought').length,
    wallMs: 132_000,
  },
  finalKpis: k3.payload,
});

void k1;
void k2;
const out = fileURLToPath(new URL('../fixtures/run.sample.events.json', import.meta.url));
writeFileSync(out, JSON.stringify(events, null, 2) + '\n');
console.log(`wrote ${events.length} events to ${out}`);
