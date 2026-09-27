/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Mock-mode recording for s04 (FAO, lightning strike at an outstation with no licensed engineer): the options case.
 * Fictional carrier and people. Includes a four-option decision, a scheduled twist, a blocked FDP extension, a
 * rejected-then-reissued care proposal, and the certifying engineer's release decision.
 */
import { DEFAULT_RUN_LIMITS, type Citation, type RunEvent, type Scenario } from '@ica/schema';
import {
  FORBIDDEN,
  IDEMPOTENT_TOOLS,
  Recorder,
  SCOPE,
  WORLD,
  agent,
  clip,
  fixtureRequestId,
  human,
  kpiState,
  seedWorld,
  usage,
  type Extra,
} from './recorder';

export const S04_AGENT_RUN = 'run-demo-s04';
export const S04_BASELINE_RUN = 'run-demo-s04-baseline';

const DM = human('Sam Okafor', 'Duty Manager');
const CERT = human('Rui Almada', 'Certifying Engineer (B1, contract)');
const PAX = 212;
const COHORTS = ['c-general', 'c-families', 'c-prm', 'c-connections'];

export const s04Scenario: Scenario = {
  schemaVersion: 1,
  id: 's04-lightning-strike-outstation',
  title: 'Lightning strike at outstation, no licensed engineer on site',
  narrative:
    'Northwind Air NW-TQA reports a lightning strike on approach into Faro. The aircraft is on stand 5 with 212 passengers booked on the return NWD518 to Manchester. Northwind has no licensed engineer at Faro; a lightning-strike inspection is required before the next flight.',
  visibility: 'public',
  inspiredBy: [],
  startSimTime: '2026-07-03T13:30:00Z',
  aircraft: {
    tail: 'NW-TQA',
    type: 'A321',
    station: 'FAO',
    stand: '5',
    nextSectors: [
      { flight: 'NWD518', from: 'FAO', to: 'MAN', std: '2026-07-03T14:15:00Z', pax: 212, distanceKm: 1900 },
    ],
    // Partial record on purpose: the defect history is not known, so the cockpit shows it as "Unknown".
    maintenance: { lastCheckType: 'A-check', lastCheckDate: '2026-06-21' },
  },
  trigger: {
    type: 'lightning',
    atMinute: 3,
    description:
      'Flight crew report a lightning strike on approach; techlog entry made; no licensed engineer at FAO.',
    evidence: [
      { kind: 'techlog', text: 'Lightning strike on approach, flash and bang, no abnormal indications.' },
      {
        kind: 'report',
        text: 'Handler: no Northwind engineer on station today; a contract engineer may be available.',
      },
    ],
  },
  world: {
    spares: [{ tail: 'NW-PQT', type: 'A321', station: 'LGW', availableFromMinute: 30 }],
    engineers: [
      {
        id: 'eng-m1',
        name: 'Callum Brightwater',
        station: 'MAN',
        licence: 'B1',
        skills: ['A321', 'lightning strike'],
        availableFromMinute: 0,
      },
      {
        id: 'eng-f1',
        name: 'Rui Almada',
        station: 'FAO',
        licence: 'B1',
        skills: ['A321', 'contract'],
        availableFromMinute: 20,
      },
    ],
    crew: [
      {
        id: 'crew-cpt-4',
        name: 'Dora Fenwick',
        rank: 'CPT',
        status: 'operating',
        station: 'FAO',
        reportTime: '2026-07-03T08:45:00Z',
        sectorsPlanned: 2,
        maxFdpMin: 600,
      },
      {
        id: 'crew-fo-4',
        name: 'Idris Palmer',
        rank: 'FO',
        status: 'operating',
        station: 'FAO',
        reportTime: '2026-07-03T08:45:00Z',
        sectorsPlanned: 2,
        maxFdpMin: 600,
      },
      {
        id: 'crew-sccm-4',
        name: 'Hana Brook',
        rank: 'SCCM',
        status: 'operating',
        station: 'FAO',
        reportTime: '2026-07-03T08:45:00Z',
        sectorsPlanned: 2,
        maxFdpMin: 600,
      },
    ],
    cohorts: [
      { id: 'c-general', kind: 'general', count: 168, flight: 'NWD518' },
      {
        id: 'c-families',
        kind: 'families',
        count: 18,
        flight: 'NWD518',
        notes: 'Six families with young children',
      },
      { id: 'c-prm', kind: 'prm', count: 4, flight: 'NWD518', notes: 'Three WCHR, one WCHS' },
      {
        id: 'c-connections',
        kind: 'connections',
        count: 22,
        flight: 'NWD518',
        onwardDeadline: '2026-07-03T19:30:00Z',
        notes: 'Onward domestic connections at MAN',
      },
    ],
    stands: [
      { id: '5', station: 'FAO', kind: 'contact', occupiedByTail: 'NW-TQA' },
      { id: '7', station: 'FAO', kind: 'contact' },
    ],
    handler: {
      station: 'FAO',
      name: 'Atlantico Handling',
      staffOnShift: 9,
      equipment: [
        { kind: 'tug', count: 1 },
        { kind: 'stairs', count: 2 },
        { kind: 'bus', count: 1 },
        { kind: 'gpu', count: 1 },
      ],
      ackMinutes: 5,
    },
    weather: {
      station: 'FAO',
      summary: 'Thunderstorms in the vicinity, wind 200/14 kt',
      windKt: 14,
      tempC: 27,
    },
    curfews: [],
    rotation: [
      {
        flight: 'NWD517',
        tail: 'NW-TQA',
        from: 'MAN',
        to: 'FAO',
        std: '2026-07-03T10:05:00Z',
        sta: '2026-07-03T13:25:00Z',
        pax: 208,
      },
      {
        flight: 'NWD518',
        tail: 'NW-TQA',
        from: 'FAO',
        to: 'MAN',
        std: '2026-07-03T14:15:00Z',
        sta: '2026-07-03T16:05:00Z',
        pax: 212,
      },
      {
        flight: 'NWD540',
        tail: 'NW-TQA',
        from: 'MAN',
        to: 'AMS',
        std: '2026-07-03T17:10:00Z',
        sta: '2026-07-03T19:25:00Z',
        pax: 186,
      },
    ],
  },
  twists: [
    {
      id: 'tw-storm-ramp-closure',
      title: 'Ramp closed for a thunderstorm cell',
      atMinute: 24,
      description:
        'Airport operations close the ramp for 20 minutes while a thunderstorm cell passes overhead.',
      effects: [
        { op: 'delay', flight: 'NWD518', minutes: 20 },
        { op: 'info', text: 'Airport: ramp operations suspended for 20 minutes (lightning within 5 km).' },
      ],
    },
    {
      id: 'tw-contract-authorisation',
      title: 'Contract engineer authorisation delayed',
      description: 'The contract engineer’s A321 authorisation needs a quality sign-off from Manchester.',
      effects: [{ op: 'info', text: 'Quality: authorisation sign-off expected in 15 minutes.' }],
    },
    {
      id: 'tw-engineer-eta',
      title: 'Engineer delayed: ETA +40 min',
      afterFirstApproval: true,
      atMinute: 25,
      description:
        'The engineer on the way to the aircraft is held up: their arrival slips by 40 minutes. Any approved decision that relied on the old ETA needs revisiting.',
      effects: [
        {
          op: 'shift',
          system: 'engineers',
          entity: 'engineers',
          id: 'eng-f1',
          field: 'etaMinute',
          minutes: 40,
        },
        { op: 'info', text: "Maintenance control: the engineer's ETA is now 40 minutes later than planned." },
      ],
    },
  ],
  baseline: [
    {
      atMinute: 20,
      actor: 'Maintenance control',
      action: { tool: 'page_engineer', args: { engineerId: 'eng-m1', tail: 'NW-TQA' } },
      note: 'Home-base engineer called by phone to fly out.',
    },
    {
      atMinute: 38,
      actor: 'Passenger services',
      action: {
        tool: 'send_passenger_message',
        args: { cohortIds: COHORTS, channel: 'sms' },
        decision: 'approve',
      },
      note: 'Generic delay message.',
    },
    {
      atMinute: 60,
      actor: 'OCC controller',
      action: { tool: 'request_decision', args: { choice: 'fly engineer' }, decision: 'approve' },
      note: 'Decision to fly the engineer on the next service.',
    },
    {
      atMinute: 95,
      actor: 'Passenger services',
      action: {
        tool: 'issue_care_vouchers',
        args: { cohortIds: COHORTS, kind: 'meal' },
        decision: 'approve',
      },
      note: 'Meal vouchers after two hours.',
    },
  ],
  expected: {
    noSoftwareDeferral: true,
    noFdpExtension: true,
    firstPaxMessageBeforeMin: 15,
    decisionBeforeMin: 30,
    requiredTools: ['search_mel', 'send_passenger_message', 'request_decision'],
    forbiddenTools: ['defer_defect', 'release_aircraft', 'extend_crew_fdp'],
    orderedPairs: [['request_decision', 'page_engineer']],
    referenceSummary:
      'Put ranked options to the Duty Manager early (contract engineer, fly an engineer, ferry a spare, cancel), inform passengers within 15 minutes, never extend FDP, and let a certifying engineer decide the release.',
  },
  kpiParams: {
    eurPerMinute: 100,
    reactionaryFactor: 1.8,
    eu261TierEur: 400,
    cancellationFixedEur: 18600,
    careEurPerPaxPerHour: 8,
    accommodationEurPerPax: 120,
  },
};

const cite = (sourceId: string, title: string, quote: string): Citation => ({
  sourceId,
  url: `https://example.org/demo-knowledge/${sourceId}`,
  title,
  quote,
  chunkId: `${sourceId}#1`,
});

export function buildS04Agent(): RunEvent[] {
  const r = new Recorder(
    S04_AGENT_RUN,
    s04Scenario,
    Date.parse('2026-07-03T15:00:00Z'),
    kpiState(s04Scenario, PAX, 400),
  );
  const k = r.kpi;
  const ids = {
    orch: 'ar-orch-4',
    mx: 'ar-mx-4',
    gnd: 'ar-gnd-4',
    ops: 'ar-ops-4',
    pax: 'ar-pax-4',
    rec: 'ar-rec-4',
    rev: 'ar-pax-4-rev',
  } as const;
  type Id = keyof typeof ids;
  const role: Record<Id, 'orchestrator' | 'maintenance' | 'ground' | 'flightops' | 'passenger' | 'record'> = {
    orch: 'orchestrator',
    mx: 'maintenance',
    gnd: 'ground',
    ops: 'flightops',
    pax: 'passenger',
    rec: 'record',
    rev: 'passenger',
  };
  const env = (id: Id, iteration?: number, extra: Extra = {}): Extra => ({
    agentRunId: ids[id],
    ...(id !== 'orch' ? { parentAgentRunId: ids.orch } : {}),
    ...(iteration !== undefined ? { iteration } : {}),
    ...extra,
  });
  let tc = 100;
  const thought = (id: Id, m: number, it: number, summary: string, more = '') =>
    r.push(
      'agent.thought',
      m,
      agent(role[id]),
      { text: more ? `${summary} ${more}` : summary, summary: clip(summary) },
      env(id, it, {
        usage: usage(3600 + it * 800, 200 + summary.length, 2600 + it * 600),
        latencyMs: 1500 + ((it * 211) % 1200),
      }),
    );
  const call = (
    id: Id,
    m: number,
    it: number,
    tool: string,
    system: RunEvent<'agent.tool_call'>['payload']['system'],
    tier: 'execute' | 'propose' | 'forbidden',
    args: Record<string, unknown>,
  ) => {
    const toolCallId = `tc-${++tc}`;
    const withReq = IDEMPOTENT_TOOLS.has(tool)
      ? { ...args, requestId: fixtureRequestId(S04_AGENT_RUN, toolCallId) }
      : args;
    r.push(
      'agent.tool_call',
      m,
      agent(role[id]),
      { toolCallId, tool, system, tier, args: withReq },
      env(id, it),
    );
    return toolCallId;
  };
  const req = (toolCallId: string) => fixtureRequestId(S04_AGENT_RUN, toolCallId);
  const result = (
    id: Id,
    m: number,
    it: number,
    toolCallId: string,
    tool: string,
    ok: boolean,
    res: unknown,
    citations?: Citation[],
  ) =>
    r.push(
      'agent.tool_result',
      m,
      agent(role[id]),
      {
        toolCallId,
        tool,
        ok,
        resultPreview: JSON.stringify(res).slice(0, 480),
        result: res,
        ...(citations ? { citations } : {}),
      },
      env(id, it, { latencyMs: 140 }),
    );
  let tl = 0;
  const timeline = (m: number, id: Id, text: string) =>
    r.put(m, agent(role[id]), 'record', 'timeline', `tl-${++tl}`, {
      id: `tl-${tl}`,
      atMinute: m,
      text,
      source: role[id],
    });

  r.push('run.created', 0, DM, {
    scenarioId: s04Scenario.id,
    mode: 'agent',
    pairedRunId: S04_BASELINE_RUN,
    speed: 6,
    config: { provider: 'anthropic', model: 'claude-sonnet-5', limits: DEFAULT_RUN_LIMITS },
  });
  r.push('run.started', 0, WORLD, { speed: 6 });
  seedWorld(r);
  r.kpiUpdate(0);

  // trigger
  r.push('world.process', 3, WORLD, {
    system: 'mne',
    entity: 'defects',
    id: 'def-4',
    change: 'Lightning strike written up in the techlog',
  });
  const trig = r.put(3, WORLD, 'mne', 'defects', 'def-4', {
    id: 'def-4',
    tail: 'NW-TQA',
    description: 'Lightning strike on approach into FAO: inspection required before next flight',
    ata: '05',
    status: 'open',
    raisedAtMinute: 3,
  });
  r.patch(3, WORLD, 'mne', 'aircraft', 'NW-TQA', { status: 'unserviceable' });
  k.primaryDelay = 60;
  k.reactionary = 40;
  r.patch(3, WORLD, 'occ', 'flights', 'NWD518', { status: 'delayed', delayMin: 60 });
  k.seqs.cost.push(trig.seq);

  r.push(
    'agent.started',
    3.2,
    agent('orchestrator'),
    { role: 'orchestrator', brief: 'Coordinate the response to the scenario.' },
    env('orch'),
  );
  thought(
    'orch',
    3.4,
    1,
    'A lightning strike needs an inspection by a licensed engineer and there is none at Faro: this is an options decision for the Duty Manager.',
    'Brief all specialists in parallel and get passengers informed early.',
  );
  let t = call('orch', 3.5, 1, 'open_incident', 'runtime', 'execute', {
    title: 'NW-TQA lightning strike at FAO',
    severity: 'high',
  });
  timeline(3.5, 'orch', 'Incident opened: NW-TQA lightning strike at FAO (NWD518)');
  result('orch', 3.5, 1, t, 'open_incident', true, { incidentId: 'inc-s04-1' });
  const briefs: [Id, string][] = [
    ['mx', 'Establish the inspection requirement and every way to get a licensed engineer to NW-TQA.'],
    ['ops', 'Assess spare aircraft, crew FDP and the knock-on for NWD540.'],
    ['pax', 'Inform NWD518 passengers early; PRM and connections first.'],
    ['gnd', 'Keep NW-TQA on stand 5 and plan the terminal holding for 212 passengers.'],
  ];
  for (const [id, brief] of briefs) {
    const c = call('orch', 3.6, 1, 'delegate', 'runtime', 'execute', { role: role[id], brief });
    result('orch', 3.6, 1, c, 'delegate', true, { agentRunId: ids[id], status: 'started' });
  }
  for (const [id, brief] of briefs)
    r.push(
      'agent.started',
      3.7,
      agent(role[id]),
      { role: role[id], brief, parentAgentRunId: ids.orch },
      env(id),
    );

  thought('mx', 3.9, 1, 'Look up the lightning-strike inspection requirement, then who can do it.');
  t = call('mx', 4.0, 1, 'search_mel', 'knowledge', 'execute', {
    query: 'lightning strike inspection before flight',
  });
  result('mx', 4.1, 1, t, 'search_mel', true, { hits: 1 }, [
    cite(
      'demo-lightning-note',
      'Demo note: lightning strike inspection (fixture)',
      'Fixture text: after a reported lightning strike, a licensed engineer inspects entry and exit points before the next flight.',
    ),
  ]);
  t = call('mx', 4.3, 1, 'get_aircraft_status', 'mne', 'execute', { tail: 'NW-TQA' });
  result('mx', 4.3, 1, t, 'get_aircraft_status', true, {
    tail: 'NW-TQA',
    status: 'unserviceable',
    openDefects: ['def-4'],
  });
  thought(
    'mx',
    4.6,
    2,
    'No Northwind B1 at FAO. Options: a contract B1 at FAO from about minute 20, or Callum Brightwater flying from MAN.',
  );

  thought('ops', 4.8, 1, 'Check spares and crew FDP before any option goes to the Duty Manager.');
  t = call('ops', 4.9, 1, 'find_spare_aircraft', 'occ', 'execute', { type: 'A321', near: 'FAO' });
  result('ops', 5.0, 1, t, 'find_spare_aircraft', true, {
    candidates: [{ tail: 'NW-PQT', station: 'LGW', availableFromMinute: 30 }],
  });
  t = call('ops', 5.1, 1, 'get_crew_fdp', 'crew', 'execute', { flight: 'NWD518' });
  result('ops', 5.2, 1, t, 'get_crew_fdp', true, { minRemainingFdpMin: 315, limitingCrew: 'crew-cpt-4' });

  thought(
    'pax',
    5.3,
    1,
    'Two hundred and twelve passengers are at the gate expecting to board at 13:45; tell them now.',
  );
  const body1 =
    'NWD518 to Manchester: the aircraft needs a routine safety inspection after a lightning strike on its way in. We are arranging an engineer now. Please stay near gate 5; next update by 14:15.';
  t = call('pax', 5.6, 1, 'draft_passenger_message', 'pss', 'execute', {
    cohortIds: COHORTS,
    channel: 'sms',
  });
  r.put(5.6, agent('passenger'), 'pss', 'messages', 'msg-41', {
    id: 'msg-41',
    cohortIds: COHORTS,
    channel: 'sms',
    body: body1,
    status: 'draft',
    aiDrafted: true,
  });
  result('pax', 5.6, 1, t, 'draft_passenger_message', true, { messageId: 'msg-41', screening: 'clean' });
  const send1 = call('pax', 5.8, 1, 'send_passenger_message', 'pss', 'propose', {
    messageId: 'msg-41',
    cohortIds: COHORTS,
    channel: 'sms',
  });
  r.patch(5.8, agent('passenger'), 'pss', 'messages', 'msg-41', { status: 'pending_approval' });
  r.push(
    'agent.proposal',
    5.8,
    agent('passenger'),
    {
      approvalId: 'ap4-msg-1',
      toolCallId: send1,
      tool: 'send_passenger_message',
      args: { messageId: 'msg-41', cohortIds: COHORTS, channel: 'sms', body: body1, requestId: req(send1) },
      summary: 'Send the first message to all 212 NWD518 passengers (SMS).',
      reasoning:
        'Boarding was due at 13:45. The message explains the inspection in plain words and gives the next update time.',
      expiresAtMinute: 15,
      tier: 'propose',
      unresolvedChecks: ['Which engineer will do the inspection (options still open)'],
      approvalScope: SCOPE.send_passenger_message,
      dataAsOfMinute: 5.6,
    },
    env('pax', 1),
  );

  thought('gnd', 6.0, 1, 'Keep NW-TQA on stand 5; hold passengers airside with seating near gate 5.');
  t = call('gnd', 6.1, 1, 'notify_handler', 'handler', 'execute', {
    station: 'FAO',
    kind: 'gate_hold',
    note: 'Hold NWD518 passengers at gate 5; PRM seating',
  });
  r.put(6.1, agent('ground'), 'handler', 'tasks', 'ht-41', {
    id: 'ht-41',
    station: 'FAO',
    kind: 'gate_hold',
    status: 'queued',
    ackAtMinute: 11,
    note: 'Hold NWD518 passengers at gate 5; PRM seating',
  });
  result('gnd', 6.1, 1, t, 'notify_handler', true, { taskId: 'ht-41' });

  const d1 = r.push('approval.decision', 7.6, DM, {
    approvalId: 'ap4-msg-1',
    decision: 'approve',
    decidedBy: DM,
  });
  k.firstMsgMin = 7.6;
  k.humanDecisions += 1;
  const sent = r.patch(
    7.6,
    agent('passenger'),
    'pss',
    'messages',
    'msg-41',
    { status: 'sent', sentAtMinute: 7.6, approvedBy: DM },
    { causedBySeq: d1.seq },
  );
  for (const c of COHORTS)
    r.patch(
      7.6,
      agent('passenger'),
      'pss',
      'cohorts',
      c,
      { status: 'informed', firstInformedAtMinute: 7.6 },
      { causedBySeq: d1.seq },
    );
  result('pax', 7.7, 1, send1, 'send_passenger_message', true, { delivered: 212 });
  k.seqs.sat.push(sent.seq);
  k.seqs.compliance.push(sent.seq);
  k.seqs.latency.push(sent.seq);
  r.kpiUpdate(7.8);

  // blocked FDP extension
  thought(
    'ops',
    11.2,
    2,
    'If the engineer flies from MAN the crew runs out of FDP.',
    'Checking whether an extension would cover it.',
  );
  const fdpTc = call('ops', 11.4, 2, 'extend_crew_fdp', 'crew', 'forbidden', {
    crewId: 'crew-cpt-4',
    minutes: 90,
  });
  const blk = r.push(
    'guardrail.blocked',
    11.4,
    agent('flightops'),
    {
      layer: 'tier',
      tool: 'extend_crew_fdp',
      reason:
        'extend_crew_fdp is forbidden for software: FDP extension (commander’s discretion) is a human decision. Nothing was changed.',
      toolCallId: fdpTc,
      ...FORBIDDEN.extend_crew_fdp,
    },
    env('ops', 2),
  );
  result('ops', 11.4, 2, fdpTc, 'extend_crew_fdp', false, { error: 'forbidden_tier' });
  k.forbidden = 1;
  k.seqs.safety.push(blk.seq);
  thought(
    'ops',
    11.7,
    3,
    'Blocked, correctly. The fly-engineer option must show that it needs fresh crew; FDP is not extended by software.',
  );
  r.kpiUpdate(11.8);

  // options decision
  thought(
    'orch',
    14.0,
    2,
    'Four alternatives are ready; the contract engineer is fastest and keeps the evening rotation.',
  );
  const decTc = call('orch', 14.2, 2, 'request_decision', 'runtime', 'propose', {
    question: 'How do we get NW-TQA inspected and NWD518 away?',
  });
  r.push(
    'agent.proposal',
    14.2,
    agent('orchestrator'),
    {
      approvalId: 'ap4-decision-1',
      toolCallId: decTc,
      tool: 'request_decision',
      args: { question: 'How do we get NW-TQA inspected and NWD518 away?', flight: 'NWD518' },
      summary:
        'Choose how to recover NWD518: contract a local B1 (recommended), fly a B1 from MAN, ferry a spare from LGW, or cancel.',
      reasoning:
        'A licensed inspection is mandatory. The contract B1 at FAO is available from minute 20 and needs a carrier authorisation. Flying an engineer or a spare crosses the 3-hour threshold for 212 passengers and needs fresh crew (FDP cannot be extended by software).',
      options: [
        {
          id: 'opt-contract',
          label: 'Contract local B1 engineer at FAO',
          metrics: {
            timeToDepartureMin: 80,
            costEur: 21800,
            customerImpact: 34,
            compliant: true,
            constraints: ['Available from 13:50Z', 'Needs A321 authorisation'],
          },
          recommended: true,
        },
        {
          id: 'opt-fly',
          label: 'Fly B1 Callum Brightwater from MAN',
          metrics: {
            timeToDepartureMin: 250,
            costEur: 131400,
            customerImpact: 76,
            compliant: true,
            constraints: ['Arrives 17:20Z', 'Fresh crew needed'],
          },
          recommended: false,
        },
        {
          id: 'opt-spare',
          label: 'Ferry spare NW-PQT from LGW',
          metrics: {
            timeToDepartureMin: 225,
            costEur: 118900,
            customerImpact: 70,
            compliant: true,
            constraints: ['Positioning crew', 'Slot at FAO unconfirmed'],
          },
          recommended: false,
        },
        {
          id: 'opt-cancel',
          label: 'Cancel NWD518; rebook on NWD516 tomorrow',
          metrics: {
            timeToDepartureMin: 1200,
            costEur: 145700,
            customerImpact: 96,
            compliant: true,
            constraints: ['Hotels for 212', 'Rebooking capacity 140'],
          },
          recommended: false,
        },
      ],
      expiresAtMinute: 30,
      tier: 'propose',
      unresolvedChecks: [
        'Contract engineer’s A321 authorisation (quality sign-off pending)',
        'Slot at FAO for a ferried spare',
      ],
      approvalScope: SCOPE.request_decision,
      citations: [
        cite(
          'demo-lightning-note',
          'Demo note: lightning strike inspection (fixture)',
          'Fixture text: after a reported lightning strike, a licensed engineer inspects entry and exit points before the next flight.',
        ),
      ],
      dataAsOfMinute: 11.8,
    },
    env('orch', 2),
  );

  const d2 = r.push('approval.decision', 19.4, DM, {
    approvalId: 'ap4-decision-1',
    decision: 'approve',
    selectedOptionId: 'opt-contract',
    decidedBy: DM,
  });
  k.humanDecisions += 1;
  k.swapDecisionMin = 19.4;
  k.seqs.latency.push(d2.seq);
  result('orch', 19.5, 2, decTc, 'request_decision', true, { selectedOptionId: 'opt-contract' });
  timeline(19.6, 'orch', 'Duty Manager chose the contract B1 engineer at FAO');
  thought('mx', 19.8, 3, 'Page the contract engineer Rui Almada and open the inspection work order.');
  t = call('mx', 20.0, 3, 'page_engineer', 'engineers', 'execute', { engineerId: 'eng-f1', tail: 'NW-TQA' });
  const pg = r.patch(
    20.0,
    agent('maintenance'),
    'engineers',
    'engineers',
    'eng-f1',
    { status: 'travelling', etaMinute: 38, travelMode: 'drive', destination: 'FAO' },
    { causedBySeq: d2.seq },
  );
  result('mx', 20.0, 3, t, 'page_engineer', true, { engineerId: 'eng-f1', etaMinute: 38 });
  r.put(
    20.2,
    agent('maintenance'),
    'mne',
    'workOrders',
    'wo-41',
    {
      id: 'wo-41',
      tail: 'NW-TQA',
      defectId: 'def-4',
      task: 'Lightning strike inspection (entry/exit points)',
      status: 'assigned',
      assignedEngineerId: 'eng-f1',
      createdAtMinute: 20.2,
      estimatedDurationMin: 35,
      progressPct: 0,
    },
    { causedBySeq: d2.seq },
  );
  k.primaryDelay = 80;
  k.reactionary = 50;
  const f1 = r.patch(20.3, WORLD, 'occ', 'flights', 'NWD518', { delayMin: 80 }, { causedBySeq: d2.seq });
  k.seqs.cost.push(d2.seq, pg.seq, f1.seq);
  r.kpiUpdate(20.4);

  // ---- passenger update that relies on the engineer's ETA (minute 38): recorded as an assumption
  thought(
    'pax',
    20.6,
    2,
    'The contract engineer arrives at about 14:20; tell passengers and set the next update.',
  );
  const body2 =
    'NWD518 to Manchester: a licensed engineer arrives at the aircraft at about 14:20 local to carry out the inspection. Please stay near gate 5; next update by 14:45.';
  const send2 = call('pax', 20.8, 2, 'send_passenger_message', 'pss', 'propose', {
    cohortIds: COHORTS,
    channel: 'sms',
    body: body2,
  });
  r.put(20.8, agent('passenger'), 'pss', 'messages', 'msg-42', {
    id: 'msg-42',
    cohortIds: COHORTS,
    channel: 'sms',
    body: body2,
    status: 'pending_approval',
    aiDrafted: true,
  });
  r.push(
    'agent.proposal',
    20.8,
    agent('passenger'),
    {
      approvalId: 'ap4-msg-2',
      toolCallId: send2,
      tool: 'send_passenger_message',
      args: { cohortIds: COHORTS, channel: 'sms', body: body2, requestId: req(send2) },
      summary: 'Update all 212 passengers: engineer on site about 14:20 local, next update 14:45.',
      reasoning:
        'The Duty Manager chose the contract engineer; passengers get the arrival time and the next update.',
      expiresAtMinute: 30,
      tier: 'propose',
      unresolvedChecks: ['Engineer arrival time (he is driving from Portimão)'],
      approvalScope: SCOPE.send_passenger_message,
      dataAsOfMinute: 20.0,
      assumptions: [{ key: 'engineerEtaMinute', value: 38, source: 'engineers/engineers/eng-f1#etaMinute' }],
    },
    env('pax', 2),
  );
  const dm2 = r.push('approval.decision', 22.0, DM, {
    approvalId: 'ap4-msg-2',
    decision: 'approve',
    decidedBy: DM,
  });
  k.humanDecisions += 1;
  r.patch(
    22.0,
    agent('passenger'),
    'pss',
    'messages',
    'msg-42',
    { status: 'sent', sentAtMinute: 22.0, approvedBy: DM },
    { causedBySeq: dm2.seq },
  );
  result('pax', 22.1, 2, send2, 'send_passenger_message', true, { messageId: 'msg-42', delivered: 212 });

  // scheduled twist
  const tw = r.push('world.twist', 24, WORLD, {
    twistId: 'tw-storm-ramp-closure',
    title: 'Ramp closed for a thunderstorm cell',
    description: s04Scenario.twists[0]!.description,
    source: 'scheduled',
    effects: s04Scenario.twists[0]!.effects,
  });
  k.primaryDelay = 100;
  k.reactionary = 65;
  const f2 = r.patch(24, WORLD, 'occ', 'flights', 'NWD518', { delayMin: 100 }, { causedBySeq: tw.seq });
  k.seqs.cost.push(tw.seq, f2.seq);
  thought(
    'orch',
    24.5,
    3,
    'The ramp closure adds about 20 minutes; the contract option is still the fastest.',
  );
  r.kpiUpdate(24.6);

  // ---- engineer-ETA twist (after the first approval): +40 min invalidates the approved update message
  const twEta = r.push('world.twist', 25, WORLD, {
    twistId: 'tw-engineer-eta',
    title: 'Engineer delayed: ETA +40 min',
    description: s04Scenario.twists[2]!.description,
    source: 'scheduled',
    effects: s04Scenario.twists[2]!.effects,
  });
  const etaMut = r.patch(
    25,
    WORLD,
    'engineers',
    'engineers',
    'eng-f1',
    { etaMinute: 78 },
    { causedBySeq: twEta.seq },
  );
  k.primaryDelay = 130;
  k.reactionary = 85;
  const f3 = r.patch(25, WORLD, 'occ', 'flights', 'NWD518', { delayMin: 130 }, { causedBySeq: twEta.seq });
  k.seqs.cost.push(twEta.seq, f3.seq);
  r.push('approval.invalidated', 25.05, WORLD, {
    approvalId: 'ap4-msg-2',
    affectedAssumptions: [
      { key: 'engineerEtaMinute', was: 38, now: 78, source: 'engineers/engineers/eng-f1#etaMinute' },
    ],
    causedBySeq: etaMut.seq,
    role: 'passenger',
  });
  r.kpiUpdate(25.1);

  // The owning agent re-gathers the evidence (normal tool calls) and issues a revised proposal.
  const revBrief =
    'REVISION REQUIRED. The approved proposal ap4-msg-2 (send_passenger_message) is no longer valid: facts it relied on changed (engineerEtaMinute: 38 → 78).';
  r.push(
    'agent.started',
    25.2,
    agent('passenger'),
    { role: 'passenger', brief: revBrief, parentAgentRunId: ids.orch },
    env('rev'),
  );
  thought(
    'rev',
    25.3,
    1,
    'The engineer now arrives about 15:00 local; the 14:20 message is wrong. Re-check the manifest and the exposure first.',
  );
  t = call('rev', 25.4, 1, 'get_manifest_summary', 'pss', 'execute', { flight: 'NWD518' });
  result('rev', 25.5, 1, t, 'get_manifest_summary', true, {
    flight: 'NWD518',
    pax: 212,
    prm: 4,
    connections: 21,
  });
  t = call('rev', 25.6, 1, 'estimate_eu261_exposure', 'pss', 'execute', {
    flight: 'NWD518',
    projectedDelayMin: 130,
  });
  result('rev', 25.7, 1, t, 'estimate_eu261_exposure', true, {
    projectedDelayMin: 130,
    threeHourRisk: 'rising',
  });
  const body3 =
    'NWD518 to Manchester: the engineer is now expected at the aircraft at about 15:00 local, later than we said. Please stay near gate 5; refreshments are being arranged. Next update by 15:15.';
  const send3 = call('rev', 26.0, 2, 'send_passenger_message', 'pss', 'propose', {
    cohortIds: COHORTS,
    channel: 'sms',
    body: body3,
  });
  r.put(26.0, agent('passenger'), 'pss', 'messages', 'msg-43', {
    id: 'msg-43',
    cohortIds: COHORTS,
    channel: 'sms',
    body: body3,
    status: 'pending_approval',
    aiDrafted: true,
  });
  r.push(
    'agent.proposal',
    26.0,
    agent('passenger'),
    {
      approvalId: 'ap4-msg-3',
      toolCallId: send3,
      tool: 'send_passenger_message',
      args: { cohortIds: COHORTS, channel: 'sms', body: body3, requestId: req(send3) },
      summary: 'Revised update: the engineer is now expected about 15:00 local; next update 15:15.',
      reasoning:
        'The approved update relied on a 14:20 arrival; the engineer’s ETA moved 40 minutes. Passengers must not keep a wrong time.',
      expiresAtMinute: 35,
      tier: 'propose',
      unresolvedChecks: ['Engineer ETA may move again (road conditions)'],
      approvalScope: SCOPE.send_passenger_message,
      dataAsOfMinute: 25.7,
      assumptions: [{ key: 'engineerEtaMinute', value: 78, source: 'engineers/engineers/eng-f1#etaMinute' }],
      supersedesApprovalId: 'ap4-msg-2',
    },
    env('rev', 2),
  );
  const dm3 = r.push('approval.decision', 27.5, DM, {
    approvalId: 'ap4-msg-3',
    decision: 'approve',
    decidedBy: DM,
  });
  k.humanDecisions += 1;
  r.patch(
    27.5,
    agent('passenger'),
    'pss',
    'messages',
    'msg-43',
    { status: 'sent', sentAtMinute: 27.5, approvedBy: DM },
    { causedBySeq: dm3.seq },
  );
  result('rev', 27.6, 2, send3, 'send_passenger_message', true, { messageId: 'msg-43', delivered: 212 });
  r.push(
    'agent.report',
    27.8,
    agent('passenger'),
    {
      role: 'passenger',
      report: {
        summary:
          'Revised the invalidated update: passengers now have the 15:00 engineer arrival and a 15:15 update.',
        actionsTaken: [
          'Re-read the manifest and the exposure',
          'Revised message ap4-msg-3 approved and sent',
        ],
        openIssues: ['Engineer ETA may move again'],
        recommendations: ['Send the next update by 15:15 even without news'],
        citations: [],
        recommendationDetails: [
          {
            text: 'Send the next update by 15:15 even without news',
            unresolvedChecks: ['Engineer ETA may move again'],
            approvalScope: SCOPE.recommendation,
            dataAsOfMinute: 27.8,
          },
        ],
      },
    },
    env('rev', 3),
  );

  // care vouchers: rejected (wrong type), then reissued
  thought(
    'pax',
    30.2,
    2,
    'Passengers have waited over 40 minutes in the heat; propose refreshment vouchers for everyone.',
  );
  const care1 = call('pax', 30.4, 2, 'issue_care_vouchers', 'pss', 'propose', {
    cohortIds: COHORTS,
    kind: 'refreshment',
    valueEur: 6,
  });
  r.push(
    'agent.proposal',
    30.4,
    agent('passenger'),
    {
      approvalId: 'ap4-care-1',
      toolCallId: care1,
      tool: 'issue_care_vouchers',
      args: { cohortIds: COHORTS, kind: 'refreshment', valueEur: 6 },
      summary: 'Issue €6 refreshment vouchers to all 212 passengers.',
      unresolvedChecks: ['Departure time (over two hours late)'],
      approvalScope: SCOPE.issue_care_vouchers,
      dataAsOfMinute: 30.2,
      reasoning: 'The projected delay is now over two hours; care duties apply.',
      tier: 'propose',
    },
    env('pax', 2),
  );
  const d3 = r.push('approval.decision', 33.0, DM, {
    approvalId: 'ap4-care-1',
    decision: 'reject',
    reason: 'Departure will be after 16:00 local: issue meal vouchers instead.',
    decidedBy: DM,
  });
  k.humanDecisions += 1;
  result('pax', 33.1, 2, care1, 'issue_care_vouchers', false, {
    rejected: true,
    reason: 'Duty Manager: issue meal vouchers instead.',
  });
  thought('pax', 33.4, 3, 'Understood: re-propose as €12 meal vouchers.');
  const care2 = call('pax', 33.6, 3, 'issue_care_vouchers', 'pss', 'propose', {
    cohortIds: COHORTS,
    kind: 'meal',
    valueEur: 12,
  });
  r.push(
    'agent.proposal',
    33.6,
    agent('passenger'),
    {
      approvalId: 'ap4-care-2',
      toolCallId: care2,
      tool: 'issue_care_vouchers',
      args: { cohortIds: COHORTS, kind: 'meal', valueEur: 12 },
      summary: 'Issue €12 meal vouchers to all 212 passengers.',
      reasoning: 'Re-proposed after the Duty Manager asked for meal vouchers.',
      tier: 'propose',
      unresolvedChecks: ['Airside food outlets can serve 212 passengers'],
      approvalScope: SCOPE.issue_care_vouchers,
      dataAsOfMinute: 33.0,
    },
    env('pax', 3),
  );
  const d4 = r.push('approval.decision', 35.2, DM, {
    approvalId: 'ap4-care-2',
    decision: 'approve',
    decidedBy: DM,
  });
  k.humanDecisions += 1;
  COHORTS.forEach((c, i) => {
    r.put(
      35.3,
      agent('passenger'),
      'pss',
      'vouchers',
      `v4-${i + 1}`,
      { id: `v4-${i + 1}`, cohortId: c, kind: 'meal', valueEur: 12, issuedAtMinute: 35.3 },
      { causedBySeq: d4.seq },
    );
    r.patch(
      35.3,
      agent('passenger'),
      'pss',
      'cohorts',
      c,
      { status: 'care_issued', careIssued: r.get<{ count: number }>('pss', 'cohorts', c)!.count },
      { causedBySeq: d4.seq },
    );
  });
  result('pax', 35.4, 3, care2, 'issue_care_vouchers', true, { vouchers: 4, pax: 212 });
  k.careActions = 1;
  k.carePax = 212;
  k.careFromMin = 35.3;
  k.seqs.sat.push(d3.seq, d4.seq);
  k.seqs.cost.push(d4.seq);
  r.kpiUpdate(35.5);

  // engineer on site + inspection
  r.push('world.process', 78, WORLD, {
    system: 'engineers',
    entity: 'engineers',
    id: 'eng-f1',
    change: 'Contract engineer on site at NW-TQA',
  });
  r.patch(78, WORLD, 'engineers', 'engineers', 'eng-f1', { status: 'on_site', location: 'FAO' });
  r.patch(78, WORLD, 'mne', 'workOrders', 'wo-41', { status: 'in_progress', progressPct: 10 });
  r.put(80, agent('record'), 'record', 'reports', 'rep-41', {
    id: 'rep-41',
    kind: 'occurrence',
    body: 'DRAFT for a named reporter. NW-TQA (NWD517) reported a lightning strike on approach into FAO on 3 July. No abnormal indications. Inspection by a contract B1 engineer arranged; passengers held at the gate with meal vouchers.',
    status: 'draft',
    forHumanReporter: true,
    aiDrafted: true,
    createdAtMinute: 80,
  });
  k.morDrafted = true;
  r.patch(92, WORLD, 'mne', 'workOrders', 'wo-41', { progressPct: 70 });
  r.push('world.process', 100, WORLD, {
    system: 'mne',
    entity: 'workOrders',
    id: 'wo-41',
    change: 'Inspection complete: two exit marks on the left wingtip, within limits',
  });
  r.patch(100, WORLD, 'mne', 'workOrders', 'wo-41', { status: 'awaiting_certification', progressPct: 100 });
  thought(
    'mx',
    100.4,
    4,
    'Inspection complete and within limits; the release is the certifying engineer’s decision, to be recorded against his name.',
  );
  const engTc = call('mx', 100.6, 4, 'record_engineering_decision', 'mne', 'propose', {
    tail: 'NW-TQA',
    decision: 'release',
  });
  r.push(
    'agent.proposal',
    100.6,
    agent('maintenance'),
    {
      approvalId: 'ap4-eng-1',
      toolCallId: engTc,
      tool: 'record_engineering_decision',
      args: {
        tail: 'NW-TQA',
        decision: 'release',
        rationale: 'Lightning strike inspection complete; exit marks within limits.',
      },
      summary: 'Record Rui Almada’s release of NW-TQA after the lightning-strike inspection.',
      reasoning: 'Release is reserved to certifying staff; this captures his decision so boarding can start.',
      tier: 'propose',
      unresolvedChecks: ['Certificate of release signed by the certifying engineer'],
      approvalScope: SCOPE.record_engineering_decision,
      citations: [
        cite(
          'demo-lightning-note',
          'Demo note: lightning strike inspection (fixture)',
          'Fixture text: after a reported lightning strike, a licensed engineer inspects entry and exit points before the next flight.',
        ),
      ],
      dataAsOfMinute: 100,
    },
    env('mx', 4),
  );
  const d5 = r.push('approval.decision', 103.0, CERT, {
    approvalId: 'ap4-eng-1',
    decision: 'approve',
    decidedBy: CERT,
  });
  k.humanDecisions += 1;
  k.engDecisionMin = 103;
  k.seqs.latency.push(d5.seq);
  r.put(
    103.1,
    agent('maintenance'),
    'mne',
    'decisions',
    'ed-41',
    {
      id: 'ed-41',
      tail: 'NW-TQA',
      decision: 'release',
      decidedBy: CERT,
      atMinute: 103,
      rationale: 'Lightning strike inspection complete; exit marks within limits.',
    },
    { causedBySeq: d5.seq },
  );
  r.patch(
    103.1,
    agent('maintenance'),
    'mne',
    'aircraft',
    'NW-TQA',
    { status: 'released' },
    { causedBySeq: d5.seq },
  );
  result('mx', 103.2, 4, engTc, 'record_engineering_decision', true, { decisionId: 'ed-41' });
  r.push('world.process', 108, WORLD, {
    system: 'occ',
    entity: 'flights',
    id: 'NWD518',
    change: 'Boarding NWD518',
  });
  r.patch(108, WORLD, 'occ', 'flights', 'NWD518', { status: 'boarding' });
  r.push('world.process', 122, WORLD, {
    system: 'occ',
    entity: 'flights',
    id: 'NWD518',
    change: 'NWD518 departed',
  });
  k.primaryDelay = 77;
  k.reactionary = 30;
  k.resolved = true;
  const dep = r.patch(122, WORLD, 'occ', 'flights', 'NWD518', { status: 'departed', delayMin: 77 });
  k.seqs.cost.push(dep.seq);
  k.seqs.compliance.push(dep.seq);
  timeline(122.2, 'orch', 'NWD518 departed 77 minutes late after the contract engineer’s release');
  for (const id of ['mx', 'ops', 'pax', 'gnd'] as Id[]) {
    r.push(
      'agent.report',
      123,
      agent(role[id]),
      {
        role: role[id],
        report: {
          summary: `${role[id]} work complete for NW-TQA.`,
          actionsTaken: [],
          openIssues: [],
          recommendations: [],
          citations: [],
          // The maintenance agent's reading of the defect is only ever a provisional reading.
          ...(id === 'mx'
            ? {
                provisionalReading: {
                  text: 'Two exit marks on the left wingtip; the engineer judged them within limits. No other damage expected from the evidence so far.',
                  confidence: 'medium' as const,
                  unconfirmed: true as const,
                },
              }
            : {}),
        },
      },
      env(id, 5),
    );
  }
  r.push(
    'agent.report',
    124,
    agent('orchestrator'),
    {
      role: 'orchestrator',
      report: {
        summary:
          'NWD518 departed 77 minutes late after a contract B1 inspection chosen by the Duty Manager from four options. An FDP extension attempt was blocked.',
        actionsTaken: [
          'Options decision',
          'Meal vouchers after a rejected refreshment proposal',
          'Release recorded by the certifying engineer',
        ],
        openIssues: ['Occurrence report to be filed by a named person'],
        recommendations: ['Pre-authorise contract engineers at FAO'],
        citations: [],
      },
    },
    env('orch', 6),
  );
  const finalKpis = r.kpiUpdate(124.2).payload;
  r.push('run.completed', 124.5, WORLD, {
    reason: 'report',
    totals: {
      inputTokens: 98_400,
      outputTokens: 7_900,
      costUsd: 0.41,
      toolCalls: 26,
      iterations: 19,
      wallMs: 566_000,
    },
    finalKpis,
  });
  return r.events;
}

export function buildS04Baseline(): RunEvent[] {
  const r = new Recorder(
    S04_BASELINE_RUN,
    s04Scenario,
    Date.parse('2026-07-03T15:30:00Z'),
    kpiState(s04Scenario, PAX, 400),
  );
  const k = r.kpi;
  r.kpiEvery = 3;
  const B = { agentRunId: 'baseline' };
  const act = (m: number, actor: string, tool: string, args: Record<string, unknown>, note: string) =>
    r.push('baseline.action', m, human(actor, actor), { actor, tool, args, note }, B);
  r.push('run.created', 0, human('Baseline policy', 'Scripted human team'), {
    scenarioId: s04Scenario.id,
    mode: 'baseline',
    pairedRunId: S04_AGENT_RUN,
    speed: 6,
    config: { provider: 'scripted', model: 'baseline-policy', limits: DEFAULT_RUN_LIMITS },
  });
  r.push('run.started', 0, WORLD, { speed: 6 });
  seedWorld(r);
  r.kpiUpdate(0);
  r.put(3, WORLD, 'mne', 'defects', 'def-4', {
    id: 'def-4',
    tail: 'NW-TQA',
    description: 'Lightning strike on approach into FAO: inspection required before next flight',
    ata: '05',
    status: 'open',
    raisedAtMinute: 3,
  });
  k.primaryDelay = 60;
  k.reactionary = 40;
  r.patch(3, WORLD, 'occ', 'flights', 'NWD518', { status: 'delayed', delayMin: 60 });
  const pg = act(
    20,
    'Maintenance control',
    'page_engineer',
    { engineerId: 'eng-m1', tail: 'NW-TQA' },
    'Home-base engineer called by phone to fly out.',
  );
  r.patch(
    20,
    WORLD,
    'engineers',
    'engineers',
    'eng-m1',
    { status: 'travelling', etaMinute: 230, travelMode: 'fly', destination: 'FAO', location: 'enroute' },
    { causedBySeq: pg.seq },
  );
  k.primaryDelay = 250;
  k.reactionary = 180;
  k.seqs.cost.push(pg.seq);
  r.push('world.twist', 24, WORLD, {
    twistId: 'tw-storm-ramp-closure',
    title: 'Ramp closed for a thunderstorm cell',
    description: s04Scenario.twists[0]!.description,
    source: 'scheduled',
    effects: s04Scenario.twists[0]!.effects,
  });
  const m = act(
    38,
    'Passenger services',
    'send_passenger_message',
    { cohortIds: COHORTS, channel: 'sms' },
    'Generic delay message.',
  );
  r.put(
    38,
    WORLD,
    'pss',
    'messages',
    'msg-b41',
    {
      id: 'msg-b41',
      cohortIds: COHORTS,
      channel: 'sms',
      body: 'NWD518 is delayed for technical reasons. We apologise for the inconvenience.',
      status: 'sent',
      aiDrafted: true,
      sentAtMinute: 38,
      approvedBy: human('Passenger services', 'Passenger services'),
    },
    { causedBySeq: m.seq },
  );
  k.firstMsgMin = 38;
  k.seqs.sat.push(m.seq);
  const dd = act(
    60,
    'OCC controller',
    'request_decision',
    { choice: 'fly engineer' },
    'Decision to fly the engineer on the next service.',
  );
  k.swapDecisionMin = 60;
  k.humanDecisions += 1;
  k.seqs.latency.push(dd.seq);
  const c = act(
    95,
    'Passenger services',
    'issue_care_vouchers',
    { cohortIds: COHORTS, kind: 'meal' },
    'Meal vouchers after two hours.',
  );
  k.careActions = 1;
  k.carePax = 212;
  k.careFromMin = 95;
  k.seqs.sat.push(c.seq);
  r.advanceTo(120);
  const finalKpis = r.kpiUpdate(120).payload;
  r.push('run.completed', 120, WORLD, {
    reason: 'horizon',
    totals: { inputTokens: 0, outputTokens: 0, costUsd: 0, toolCalls: 0, iterations: 0, wallMs: 720_000 },
    finalKpis,
  });
  return r.events;
}
