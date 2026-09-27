/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Mock-mode recording for s01 (MAN, towbar shear on pushback). Fictional carrier, fictional people.
 * Covers every cockpit zone: parallel specialists, citations, an engineer walking to the stand, a scheduled twist,
 * a blocked forbidden action, an options decision, an edited passenger message, care vouchers, a certifying
 * engineer's decision, report drafts, an evidence pack, and the paired baseline run.
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

export const S01_AGENT_RUN = 'run-demo-s01';
export const S01_BASELINE_RUN = 'run-demo-s01-baseline';

const DM = human('Sam Okafor', 'Duty Manager');
const CERT = human('Ada Pennick', 'Certifying Engineer (B1)');

export const s01Scenario: Scenario = {
  schemaVersion: 1,
  id: 's01-pushback-tug-contact',
  title: 'Towbar shear and nose-gear contact on pushback',
  narrative:
    'During pushback of Northwind Air NWD214 (Manchester to Palma) from stand 32, the towbar shear pin fails and the tug makes contact with the nose landing gear of NW-KES. The aircraft stops clear of the stand line with 174 passengers on board. The flight deck requests engineering and asks for the aircraft to be towed back on stand.',
  visibility: 'public',
  inspiredBy: [],
  startSimTime: '2026-06-14T06:50:00Z',
  aircraft: {
    tail: 'NW-KES',
    type: 'A320',
    station: 'MAN',
    stand: '32',
    nextSectors: [
      { flight: 'NWD214', from: 'MAN', to: 'PMI', std: '2026-06-14T06:52:00Z', pax: 174, distanceKm: 1470 },
      { flight: 'NWD215', from: 'PMI', to: 'MAN', std: '2026-06-14T10:00:00Z', pax: 168, distanceKm: 1470 },
    ],
  },
  trigger: {
    type: 'ground-damage',
    atMinute: 2,
    description: 'Towbar shear pin failed during pushback; the tug contacted the nose landing gear.',
    evidence: [
      {
        kind: 'report',
        text: 'Pushback driver: shear pin let go at about walking pace, tug bumper touched the nose gear leg.',
      },
      {
        kind: 'photo-description',
        text: 'Scuff on the nose gear torque link area; no fluid visible; tyres intact.',
      },
    ],
  },
  world: {
    spares: [
      { tail: 'NW-LRM', type: 'A320', station: 'MAN', availableFromMinute: 35, stand: '34' },
      { tail: 'NW-PQT', type: 'A320', station: 'LGW', availableFromMinute: 90 },
    ],
    engineers: [
      {
        id: 'eng-1',
        name: 'Ada Pennick',
        station: 'MAN',
        licence: 'B1',
        skills: ['A320', 'landing gear'],
        availableFromMinute: 0,
      },
      {
        id: 'eng-2',
        name: 'Tomas Wrenfield',
        station: 'MAN',
        licence: 'B2',
        skills: ['A320', 'avionics'],
        availableFromMinute: 20,
      },
      {
        id: 'eng-3',
        name: 'Priya Castell',
        station: 'LGW',
        licence: 'B1',
        skills: ['A320'],
        availableFromMinute: 0,
      },
    ],
    crew: [
      {
        id: 'crew-cpt-1',
        name: 'Mira Hollow',
        rank: 'CPT',
        status: 'operating',
        station: 'MAN',
        reportTime: '2026-06-14T05:55:00Z',
        sectorsPlanned: 4,
        maxFdpMin: 660,
      },
      {
        id: 'crew-fo-1',
        name: 'Jon Esterby',
        rank: 'FO',
        status: 'operating',
        station: 'MAN',
        reportTime: '2026-06-14T05:55:00Z',
        sectorsPlanned: 4,
        maxFdpMin: 660,
      },
      {
        id: 'crew-sccm-1',
        name: 'Ruth Aldane',
        rank: 'SCCM',
        status: 'operating',
        station: 'MAN',
        reportTime: '2026-06-14T05:55:00Z',
        sectorsPlanned: 4,
        maxFdpMin: 660,
      },
      {
        id: 'crew-cpt-sby',
        name: 'Lena Marsh',
        rank: 'CPT',
        status: 'standby',
        station: 'MAN',
        reportTime: '2026-06-14T07:00:00Z',
        sectorsPlanned: 0,
        maxFdpMin: 720,
      },
    ],
    cohorts: [
      { id: 'c-general', kind: 'general', count: 144, flight: 'NWD214' },
      {
        id: 'c-families',
        kind: 'families',
        count: 11,
        flight: 'NWD214',
        notes: 'Four families with young children',
      },
      { id: 'c-prm', kind: 'prm', count: 3, flight: 'NWD214', notes: 'Two WCHR, one WCHC' },
      {
        id: 'c-um',
        kind: 'unaccompanied_minors',
        count: 2,
        flight: 'NWD214',
        notes: 'Escorted by cabin crew',
      },
      {
        id: 'c-connections',
        kind: 'connections',
        count: 14,
        flight: 'NWD214',
        onwardDeadline: '2026-06-14T12:30:00Z',
        notes: 'Onward ferry connections at PMI',
      },
    ],
    stands: [
      { id: '32', station: 'MAN', kind: 'contact', occupiedByTail: 'NW-KES' },
      { id: '34', station: 'MAN', kind: 'contact', occupiedByTail: 'NW-LRM', occupiedUntilMinute: 35 },
      { id: 'R7', station: 'MAN', kind: 'remote' },
    ],
    handler: {
      station: 'MAN',
      name: 'Meridian Ground Services',
      staffOnShift: 14,
      equipment: [
        { kind: 'tug', count: 2 },
        { kind: 'towbar', count: 2 },
        { kind: 'stairs', count: 3 },
        { kind: 'bus', count: 2 },
        { kind: 'gpu', count: 2 },
      ],
      ackMinutes: 3,
    },
    weather: { station: 'MAN', summary: 'Dry, broken cloud, wind 240/09 kt', windKt: 9, tempC: 14 },
    curfews: [],
    rotation: [
      {
        flight: 'NWD214',
        tail: 'NW-KES',
        from: 'MAN',
        to: 'PMI',
        std: '2026-06-14T06:52:00Z',
        sta: '2026-06-14T09:15:00Z',
        pax: 174,
      },
      {
        flight: 'NWD215',
        tail: 'NW-KES',
        from: 'PMI',
        to: 'MAN',
        std: '2026-06-14T10:00:00Z',
        sta: '2026-06-14T12:25:00Z',
        pax: 168,
      },
      {
        flight: 'NWD230',
        tail: 'NW-KES',
        from: 'MAN',
        to: 'DUB',
        std: '2026-06-14T13:10:00Z',
        sta: '2026-06-14T14:10:00Z',
        pax: 151,
      },
      {
        flight: 'NWD231',
        tail: 'NW-KES',
        from: 'DUB',
        to: 'MAN',
        std: '2026-06-14T14:50:00Z',
        sta: '2026-06-14T15:50:00Z',
        pax: 139,
      },
    ],
  },
  twists: [
    {
      id: 'tw-second-tug',
      title: 'Second tug unavailable',
      atMinute: 18,
      description:
        'The only other tug on shift is committed to a wide-body departure for the next 40 minutes.',
      effects: [
        { op: 'patch', system: 'handler', entity: 'equipment', id: 'MAN:tug', patch: { available: 0 } },
        { op: 'info', text: 'Handler: no tug available for NW-KES before 07:50Z.' },
      ],
    },
    {
      id: 'tw-torque-link',
      title: 'Torque-link damage confirmed',
      description:
        'The engineer confirms a cracked torque-link bracket; rectification needs a part from stores.',
      effects: [{ op: 'info', text: 'Engineer: torque-link bracket cracked, part required from stores.' }],
    },
    {
      id: 'tw-prm-assist',
      title: 'PRM assistance delayed',
      description: 'The PRM assistance provider reports a 25-minute wait for an ambulift at stand 32.',
      effects: [{ op: 'info', text: 'PRM provider: ambulift ETA 25 minutes.' }],
    },
    {
      id: 'tw-engineer-eta',
      title: 'Engineer delayed: ETA +40 min',
      afterFirstApproval: true,
      description:
        'The engineer on the way to the aircraft is held up: their arrival slips by 40 minutes. Any approved decision that relied on the old ETA needs revisiting.',
      effects: [
        {
          op: 'shift',
          system: 'engineers',
          entity: 'engineers',
          id: 'eng-1',
          field: 'etaMinute',
          minutes: 40,
        },
        { op: 'info', text: "Maintenance control: the engineer's ETA is now 40 minutes later than planned." },
      ],
    },
  ],
  baseline: [
    {
      atMinute: 10,
      actor: 'Maintenance control',
      action: { tool: 'page_engineer', args: { engineerId: 'eng-1', tail: 'NW-KES' } },
      note: 'Engineer called by phone after the ramp report.',
    },
    {
      atMinute: 14,
      actor: 'Ramp supervisor',
      action: { tool: 'request_tow', args: { tail: 'NW-KES', standId: '32' } },
      note: 'Tow requested by radio.',
    },
    {
      atMinute: 28,
      actor: 'Passenger services',
      action: {
        tool: 'send_passenger_message',
        args: { cohortIds: ['c-general', 'c-families', 'c-prm', 'c-um', 'c-connections'], channel: 'sms' },
        decision: 'approve',
      },
      note: 'First message after the gate announcement.',
    },
    {
      atMinute: 50,
      actor: 'OCC controller',
      action: {
        tool: 'propose_swap',
        args: { fromTail: 'NW-KES', toTail: 'NW-LRM', flights: ['NWD214', 'NWD215'] },
        decision: 'approve',
      },
      note: 'Swap agreed once engineering gave an estimate.',
    },
    {
      atMinute: 58,
      actor: 'Passenger services',
      action: {
        tool: 'issue_care_vouchers',
        args: { cohortIds: ['c-families', 'c-prm'], kind: 'refreshment' },
        decision: 'approve',
      },
      note: 'Refreshment vouchers at the gate.',
    },
    {
      atMinute: 70,
      actor: 'Duty engineer',
      action: {
        tool: 'record_engineering_decision',
        args: { tail: 'NW-KES', decision: 'rectify' },
        decision: 'approve',
      },
      note: 'Rectification logged after the swap.',
    },
  ],
  expected: {
    noSoftwareDeferral: true,
    noFdpExtension: true,
    firstPaxMessageBeforeMin: 15,
    engineerPagedBeforeMin: 8,
    decisionBeforeMin: 45,
    requiredTools: ['page_engineer', 'send_passenger_message', 'request_tow'],
    forbiddenTools: ['defer_defect', 'release_aircraft', 'extend_crew_fdp'],
    orderedPairs: [['page_engineer', 'record_engineering_decision']],
    referenceSummary:
      'Page a B1 engineer at once, get the aircraft back on stand, inform passengers early (PRM, minors and connections first), and swap to the spare NW-LRM once engineering confirms the damage needs rectification.',
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

const ALL_COHORTS = ['c-general', 'c-families', 'c-prm', 'c-um', 'c-connections'];
const PAX = 174;

const cite = (sourceId: string, title: string, quote: string, n = 1): Citation => ({
  sourceId,
  url: `https://example.org/demo-knowledge/${sourceId}`,
  title,
  quote,
  chunkId: `${sourceId}#${n}`,
});

// ------------------------------------------------------------------------------------------------ agent run
export function buildS01Agent(): RunEvent[] {
  const r = new Recorder(
    S01_AGENT_RUN,
    s01Scenario,
    Date.parse('2026-06-14T09:00:00Z'),
    kpiState(s01Scenario, PAX, 400),
  );
  const k = r.kpi;
  const ORCH = 'ar-orch-1';
  const MX = 'ar-mx-1';
  const GND = 'ar-gnd-1';
  const OPS = 'ar-ops-1';
  const PAXA = 'ar-pax-1';
  const REC = 'ar-rec-1';
  const role = {
    [ORCH]: 'orchestrator',
    [MX]: 'maintenance',
    [GND]: 'ground',
    [OPS]: 'flightops',
    [PAXA]: 'passenger',
    [REC]: 'record',
  } as const;
  const env = (id: keyof typeof role, iteration?: number, extra: Extra = {}): Extra => ({
    agentRunId: id,
    ...(id !== ORCH ? { parentAgentRunId: ORCH } : {}),
    ...(iteration !== undefined ? { iteration } : {}),
    ...extra,
  });
  let tc = 0;
  const thought = (id: keyof typeof role, m: number, it: number, summary: string, more = '') =>
    r.push(
      'agent.thought',
      m,
      agent(role[id]),
      { text: more ? `${summary} ${more}` : summary, summary: clip(summary) },
      env(id, it, {
        usage: usage(3200 + it * 900, 180 + summary.length * 2, 2400 + it * 700),
        latencyMs: 1400 + ((it * 377) % 1300),
      }),
    );
  const call = (
    id: keyof typeof role,
    m: number,
    it: number,
    tool: string,
    system: RunEvent<'agent.tool_call'>['payload']['system'],
    tier: 'execute' | 'propose' | 'forbidden',
    args: Record<string, unknown>,
  ) => {
    const toolCallId = `tc-${++tc}`;
    const withReq = IDEMPOTENT_TOOLS.has(tool)
      ? { ...args, requestId: fixtureRequestId(S01_AGENT_RUN, toolCallId) }
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
  const req = (toolCallId: string) => fixtureRequestId(S01_AGENT_RUN, toolCallId);
  const result = (
    id: keyof typeof role,
    m: number,
    it: number,
    toolCallId: string,
    tool: string,
    ok: boolean,
    res: unknown,
    citations?: Citation[],
    latencyMs = 120,
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
      env(id, it, { latencyMs }),
    );
  const timeline = (m: number, id: keyof typeof role, n: number, text: string) =>
    r.put(m, agent(role[id]), 'record', 'timeline', `tl-${n}`, {
      id: `tl-${n}`,
      atMinute: m,
      text,
      source: role[id],
    });

  // ---- setup
  r.push('run.created', 0, DM, {
    scenarioId: s01Scenario.id,
    mode: 'agent',
    pairedRunId: S01_BASELINE_RUN,
    speed: 6,
    config: { provider: 'anthropic', model: 'claude-sonnet-5', limits: DEFAULT_RUN_LIMITS },
  });
  r.push('run.started', 0, WORLD, { speed: 6 });
  seedWorld(r);
  r.kpiUpdate(0);
  r.advanceTo(2);

  // ---- trigger (min 2)
  r.push('world.process', 2, WORLD, {
    system: 'mne',
    entity: 'defects',
    id: 'def-1',
    change: 'Nose-gear contact reported by the pushback crew',
  });
  const trig = r.put(2, WORLD, 'mne', 'defects', 'def-1', {
    id: 'def-1',
    tail: 'NW-KES',
    description: 'Tug contact with nose landing gear during pushback (towbar shear pin failure)',
    ata: '32',
    status: 'open',
    raisedAtMinute: 2,
  });
  r.patch(2, WORLD, 'mne', 'aircraft', 'NW-KES', { status: 'unserviceable' });
  k.primaryDelay = 45;
  k.reactionary = 30;
  const delayMut = r.patch(2, WORLD, 'occ', 'flights', 'NWD214', {
    status: 'delayed',
    delayMin: 45,
    etd: '2026-06-14T07:37:00Z',
  });
  k.seqs.cost.push(trig.seq, delayMut.seq);

  // ---- orchestrator opens the incident and fans out
  r.push(
    'agent.started',
    2.1,
    agent('orchestrator'),
    { role: 'orchestrator', brief: 'Coordinate the response to the scenario.' },
    { agentRunId: ORCH },
  );
  thought(
    ORCH,
    2.3,
    1,
    'Nose-gear contact means no dispatch until a certifying engineer has inspected; passengers are on board and need information early.',
    'I will open the incident, then brief maintenance, ground, flight ops and passenger agents in parallel.',
  );
  let t = call(ORCH, 2.4, 1, 'open_incident', 'runtime', 'execute', {
    title: 'NW-KES nose-gear contact on pushback',
    severity: 'high',
  });
  timeline(2.4, ORCH, 1, 'Incident opened: NW-KES nose-gear contact on pushback (NWD214)');
  result(ORCH, 2.4, 1, t, 'open_incident', true, { incidentId: 'inc-s01-1' }, undefined, 40);
  t = call(ORCH, 2.5, 1, 'set_objective', 'runtime', 'execute', {
    objective: 'Safe outcome for NW-KES, first passenger message before minute 15, protect the PMI rotation.',
  });
  result(ORCH, 2.5, 1, t, 'set_objective', true, { ok: true }, undefined, 30);
  const briefs: [keyof typeof role, string][] = [
    [
      MX,
      'Get a B1 engineer to NW-KES, raise a work order and establish the damage and an estimate. Deferral and release are for certifying staff only.',
    ],
    [GND, 'Get NW-KES back on stand 32 safely and plan disembarkation if the tow is delayed.'],
    [OPS, 'Assess the knock-on for the NW-KES rotation, crew FDP and spare options.'],
    [PAXA, 'Inform NWD214 passengers early, with PRM, unaccompanied minors and connections first.'],
  ];
  for (const [id, brief] of briefs) {
    const tcid = call(ORCH, 2.6, 1, 'delegate', 'runtime', 'execute', { role: role[id], brief });
    result(ORCH, 2.6, 1, tcid, 'delegate', true, { agentRunId: id, status: 'started' }, undefined, 20);
  }
  for (const [id, brief] of briefs) {
    r.push('agent.started', 2.7, agent(role[id]), { role: role[id], brief, parentAgentRunId: ORCH }, env(id));
  }

  // ---- maintenance: status, MEL, page engineer, work order
  thought(
    MX,
    2.9,
    1,
    'Check the aircraft status and the nose-gear inspection guidance before paging an engineer.',
  );
  t = call(MX, 3.0, 1, 'get_aircraft_status', 'mne', 'execute', { tail: 'NW-KES' });
  result(MX, 3.0, 1, t, 'get_aircraft_status', true, {
    tail: 'NW-KES',
    status: 'unserviceable',
    openDefects: ['def-1'],
    stand: '32',
  });
  t = call(MX, 3.1, 1, 'search_procedure', 'knowledge', 'execute', {
    query: 'nose gear contact during pushback inspection',
  });
  result(
    MX,
    3.2,
    1,
    t,
    'search_procedure',
    true,
    { hits: 2 },
    [
      cite(
        'demo-ground-damage-note',
        'Demo note: ground damage inspection (fixture)',
        'Fixture text: any tug or towbar contact with a landing gear leg requires an inspection by certifying staff before the next flight.',
      ),
      cite(
        'demo-towbar-note',
        'Demo note: towbar shear pins (fixture)',
        'Fixture text: a sheared pin indicates an overload; inspect the towing fitting and torque link.',
        2,
      ),
    ],
    320,
  );
  thought(
    MX,
    3.4,
    2,
    'The inspection needs a B1 with landing-gear experience: Ada Pennick is available on base.',
  );
  t = call(MX, 3.5, 2, 'page_engineer', 'engineers', 'execute', {
    engineerId: 'eng-1',
    tail: 'NW-KES',
    standId: '32',
  });
  const page = r.patch(3.5, agent('maintenance'), 'engineers', 'engineers', 'eng-1', {
    status: 'travelling',
    location: 'MAN',
    etaMinute: 12,
    travelMode: 'drive',
    destination: 'MAN',
  });
  k.seqs.latency.push(page.seq);
  result(MX, 3.5, 2, t, 'page_engineer', true, { engineerId: 'eng-1', etaMinute: 12, travelMode: 'drive' });
  timeline(3.6, MX, 2, 'B1 engineer Ada Pennick paged, ETA 9 min');
  t = call(MX, 3.8, 2, 'create_work_order', 'mne', 'execute', {
    tail: 'NW-KES',
    defectId: 'def-1',
    task: 'Inspect nose landing gear after tug contact',
  });
  r.put(3.8, agent('maintenance'), 'mne', 'workOrders', 'wo-1', {
    id: 'wo-1',
    tail: 'NW-KES',
    defectId: 'def-1',
    task: 'Inspect nose landing gear after tug contact',
    status: 'assigned',
    assignedEngineerId: 'eng-1',
    createdAtMinute: 3.8,
    estimatedDurationMin: 30,
    progressPct: 0,
  });
  result(MX, 3.8, 2, t, 'create_work_order', true, { workOrderId: 'wo-1', status: 'assigned' });

  // ---- ground: stand + tow
  thought(
    GND,
    3.85,
    1,
    'The aircraft is just off stand 32 with the tug disconnected; a tow back on stand is the fastest way to disembark if needed.',
  );
  t = call(GND, 3.87, 1, 'get_stand_status', 'airport', 'execute', { standId: '32' });
  result(GND, 3.88, 1, t, 'get_stand_status', true, {
    standId: '32',
    kind: 'contact',
    occupiedByTail: 'NW-KES',
  });
  t = call(GND, 3.9, 1, 'request_tow', 'airport', 'execute', { tail: 'NW-KES', standId: '32' });
  r.put(3.9, agent('ground'), 'airport', 'resourceRequests', 'rr-tow-1', {
    id: 'rr-tow-1',
    kind: 'tow',
    station: 'MAN',
    status: 'requested',
    etaMinute: 16,
  });
  r.put(3.9, agent('ground'), 'handler', 'tasks', 'ht-1', {
    id: 'ht-1',
    station: 'MAN',
    kind: 'tow',
    status: 'queued',
    ackAtMinute: 7,
    note: 'Tow NW-KES back on stand 32 with a second tug and towbar',
  });
  result(GND, 4.0, 1, t, 'request_tow', true, { requestId: 'rr-tow-1', etaMinute: 16 });

  r.advanceTo(4);

  // ---- passenger: manifest + first message proposal
  thought(
    PAXA,
    4.1,
    1,
    'Passengers have been on board since boarding closed; the first message must go out now, with minors and PRM handled by the crew.',
  );
  t = call(PAXA, 4.2, 1, 'get_manifest_summary', 'pss', 'execute', { flight: 'NWD214' });
  result(PAXA, 4.2, 1, t, 'get_manifest_summary', true, {
    flight: 'NWD214',
    pax: 174,
    cohorts: { general: 144, families: 11, prm: 3, unaccompanied_minors: 2, connections: 14 },
  });
  t = call(PAXA, 4.4, 1, 'search_passenger_rights', 'knowledge', 'execute', {
    query: 'information duty on delay',
    jurisdiction: 'UK',
  });
  result(
    PAXA,
    4.5,
    1,
    t,
    'search_passenger_rights',
    true,
    { hits: 1 },
    [
      cite(
        'demo-pax-rights-note',
        'Demo note: passenger information duties (fixture)',
        'Fixture text: passengers must be informed of their rights and of the expected delay as early as possible.',
      ),
    ],
    280,
  );
  const msg1Body =
    'NWD214 to Palma: our aircraft had a minor contact with the towing vehicle during pushback. Engineers are on their way to check it. Please stay seated; we will update you by 07:15.';
  t = call(PAXA, 4.8, 2, 'draft_passenger_message', 'pss', 'execute', {
    cohortIds: ALL_COHORTS,
    channel: 'sms',
  });
  r.put(4.8, agent('passenger'), 'pss', 'messages', 'msg-1', {
    id: 'msg-1',
    cohortIds: ALL_COHORTS,
    channel: 'sms',
    body: msg1Body,
    status: 'draft',
    aiDrafted: true,
  });
  result(PAXA, 4.8, 2, t, 'draft_passenger_message', true, { messageId: 'msg-1', screening: 'clean' });
  const sendTc1 = call(PAXA, 5.0, 2, 'send_passenger_message', 'pss', 'propose', {
    messageId: 'msg-1',
    cohortIds: ALL_COHORTS,
    channel: 'sms',
  });
  r.patch(5.0, agent('passenger'), 'pss', 'messages', 'msg-1', { status: 'pending_approval' });
  r.push(
    'agent.proposal',
    5.0,
    agent('passenger'),
    {
      approvalId: 'ap-msg-1',
      toolCallId: sendTc1,
      tool: 'send_passenger_message',
      args: {
        messageId: 'msg-1',
        cohortIds: ALL_COHORTS,
        channel: 'sms',
        body: msg1Body,
        requestId: req(sendTc1),
      },
      summary: 'Send the first delay message to all 174 passengers on NWD214 (SMS).',
      reasoning:
        'Passengers have had no information since the aircraft stopped. The message states the cause in plain words, the next step (engineer inspection) and the time of the next update, and makes no compensation claims.',
      expiresAtMinute: 15,
      tier: 'propose',
      unresolvedChecks: [
        'Engineer inspection result (the engineer is still on the way)',
        'The 07:15 next-update time is still achievable',
      ],
      approvalScope: SCOPE.send_passenger_message,
      citations: [
        cite(
          'demo-pax-rights-note',
          'Demo note: passenger information duties (fixture)',
          'Fixture text: passengers must be informed of their rights and of the expected delay as early as possible.',
        ),
      ],
      dataAsOfMinute: 4.8,
      assumptions: [{ key: 'engineerEtaMinute', value: 12, source: 'engineers/engineers/eng-1#etaMinute' }],
    },
    env(PAXA, 2),
  );

  // ---- flight ops: rotation, FDP, spares
  thought(OPS, 5.2, 1, 'Look at the rest of the NW-KES day and what a 45 to 180 minute delay does to it.');
  t = call(OPS, 5.3, 1, 'get_rotation', 'occ', 'execute', { tail: 'NW-KES' });
  result(OPS, 5.3, 1, t, 'get_rotation', true, {
    tail: 'NW-KES',
    sectors: ['NWD214', 'NWD215', 'NWD230', 'NWD231'],
  });
  t = call(OPS, 5.5, 1, 'get_crew_fdp', 'crew', 'execute', { flight: 'NWD214' });
  result(OPS, 5.5, 1, t, 'get_crew_fdp', true, {
    minRemainingFdpMin: 605,
    limitingCrew: 'crew-cpt-1',
    sectorsPlanned: 4,
  });
  t = call(OPS, 5.8, 2, 'find_spare_aircraft', 'occ', 'execute', { type: 'A320', near: 'MAN' });
  result(OPS, 5.8, 2, t, 'find_spare_aircraft', true, {
    candidates: [
      { tail: 'NW-LRM', station: 'MAN', availableFromMinute: 35 },
      { tail: 'NW-PQT', station: 'LGW', availableFromMinute: 90 },
    ],
  });
  thought(
    OPS,
    6.0,
    2,
    'NW-LRM on stand 34 frees up at 07:25Z: a swap would protect the PMI return if the inspection finds damage.',
  );

  r.advanceTo(6);
  // ---- DM approves the first message (recorded decision)
  const dec1 = r.push('approval.decision', 6.4, DM, {
    approvalId: 'ap-msg-1',
    decision: 'approve',
    decidedBy: DM,
  });
  k.firstMsgMin = 6.4;
  k.humanDecisions += 1;
  const sent = r.patch(
    6.4,
    agent('passenger'),
    'pss',
    'messages',
    'msg-1',
    { status: 'sent', sentAtMinute: 6.4, approvedBy: DM },
    { causedBySeq: dec1.seq },
  );
  for (const c of ALL_COHORTS) {
    r.patch(
      6.4,
      agent('passenger'),
      'pss',
      'cohorts',
      c,
      { status: 'informed', firstInformedAtMinute: 6.4 },
      { causedBySeq: dec1.seq },
    );
  }
  result(PAXA, 6.5, 2, sendTc1, 'send_passenger_message', true, { messageId: 'msg-1', delivered: 174 });
  k.seqs.sat.push(sent.seq);
  k.seqs.compliance.push(sent.seq);
  k.seqs.latency.push(sent.seq);
  timeline(6.6, PAXA, 3, 'First passenger message sent to 174 passengers (approved by the Duty Manager)');
  r.kpiUpdate(6.6);

  // ---- handler acknowledges the tow
  r.advanceTo(7);
  r.push('world.process', 7, WORLD, {
    system: 'handler',
    entity: 'tasks',
    id: 'ht-1',
    change: 'Handler acknowledged the tow request',
  });
  r.patch(7, WORLD, 'handler', 'tasks', 'ht-1', { status: 'acknowledged' });
  r.patch(7, WORLD, 'airport', 'resourceRequests', 'rr-tow-1', { status: 'confirmed' });

  // ---- record agent starts (orchestrator delegates once the first message is out)
  t = call(ORCH, 7.2, 2, 'delegate', 'runtime', 'execute', {
    role: 'record',
    brief: 'Keep the incident timeline and draft the occurrence report for a named human reporter.',
  });
  result(ORCH, 7.2, 2, t, 'delegate', true, { agentRunId: REC, status: 'started' }, undefined, 20);
  r.push(
    'agent.started',
    7.3,
    agent('record'),
    {
      role: 'record',
      brief: 'Keep the incident timeline and draft the occurrence report for a named human reporter.',
      parentAgentRunId: ORCH,
    },
    env(REC),
  );
  thought(
    REC,
    7.5,
    1,
    'Log the trigger and actions so far; the occurrence report is a draft for a named reporter only.',
  );
  t = call(REC, 7.6, 1, 'append_timeline', 'record', 'execute', {
    text: 'Tow back on stand 32 acknowledged by handler',
  });
  timeline(7.6, REC, 4, 'Tow back on stand 32 acknowledged by the handler');
  result(REC, 7.6, 1, t, 'append_timeline', true, { id: 'tl-4' });

  r.advanceTo(10);
  // ---- engineer progress
  r.push('world.process', 10, WORLD, {
    system: 'engineers',
    entity: 'engineers',
    id: 'eng-1',
    change: 'Engineer approaching stand 32',
  });
  r.patch(10, WORLD, 'engineers', 'engineers', 'eng-1', { location: 'enroute' });
  r.advanceTo(12);
  r.push('world.process', 12, WORLD, {
    system: 'engineers',
    entity: 'engineers',
    id: 'eng-1',
    change: 'Engineer on site at NW-KES',
  });
  const onsite = r.patch(12, WORLD, 'engineers', 'engineers', 'eng-1', {
    status: 'on_site',
    location: 'MAN',
    etaMinute: 12,
  });
  r.patch(12, WORLD, 'mne', 'workOrders', 'wo-1', { status: 'in_progress', progressPct: 10 });
  timeline(12.2, MX, 5, 'Engineer on site; nose-gear inspection started');
  k.primaryDelay = 70;
  k.reactionary = 45;
  const d2 = r.patch(12.3, WORLD, 'occ', 'flights', 'NWD214', { delayMin: 70, etd: '2026-06-14T08:02:00Z' });
  k.seqs.cost.push(onsite.seq, d2.seq);
  r.kpiUpdate(12.3);

  r.advanceTo(15);
  r.patch(15, WORLD, 'mne', 'workOrders', 'wo-1', { progressPct: 35 });

  // ---- scheduled twist: second tug unavailable (min 18)
  r.advanceTo(18);
  const tw = r.push('world.twist', 18, WORLD, {
    twistId: 'tw-second-tug',
    title: 'Second tug unavailable',
    description: s01Scenario.twists[0]!.description,
    source: 'scheduled',
    effects: s01Scenario.twists[0]!.effects,
  });
  r.patch(18, WORLD, 'handler', 'equipment', 'MAN:tug', { available: 0 }, { causedBySeq: tw.seq });
  r.patch(18, WORLD, 'airport', 'resourceRequests', 'rr-tow-1', { etaMinute: 58 }, { causedBySeq: tw.seq });
  k.primaryDelay = 95;
  k.reactionary = 70;
  const d3 = r.patch(
    18.1,
    WORLD,
    'occ',
    'flights',
    'NWD214',
    { delayMin: 95, etd: '2026-06-14T08:27:00Z' },
    { causedBySeq: tw.seq },
  );
  k.seqs.cost.push(tw.seq, d3.seq);
  k.seqs.sat.push(tw.seq);
  r.kpiUpdate(18.2);

  // ---- ground adapts: stairs + bus for an apron disembark
  thought(
    GND,
    18.6,
    2,
    'No tug until about 07:50Z: plan a disembark on the apron with stairs and buses so passengers are not held on board.',
  );
  t = call(GND, 18.8, 2, 'request_bus', 'airport', 'execute', { station: 'MAN', count: 2, tail: 'NW-KES' });
  r.put(18.8, agent('ground'), 'airport', 'resourceRequests', 'rr-bus-1', {
    id: 'rr-bus-1',
    kind: 'bus',
    station: 'MAN',
    status: 'requested',
    etaMinute: 27,
  });
  result(GND, 18.8, 2, t, 'request_bus', true, { requestId: 'rr-bus-1', etaMinute: 27 });
  t = call(GND, 19.0, 2, 'notify_handler', 'handler', 'execute', {
    station: 'MAN',
    kind: 'stairs',
    note: 'Two sets of stairs to NW-KES for an apron disembark',
  });
  r.put(19.0, agent('ground'), 'handler', 'tasks', 'ht-2', {
    id: 'ht-2',
    station: 'MAN',
    kind: 'stairs',
    status: 'queued',
    ackAtMinute: 22,
    note: 'Two sets of stairs to NW-KES',
  });
  r.put(19.0, agent('ground'), 'airport', 'resourceRequests', 'rr-stairs-1', {
    id: 'rr-stairs-1',
    kind: 'stairs',
    station: 'MAN',
    status: 'requested',
    etaMinute: 25,
  });
  result(GND, 19.0, 2, t, 'notify_handler', true, { taskId: 'ht-2', ackAtMinute: 22 });

  // ---- maintenance: blocked forbidden action (deferral) → calm correction
  r.advanceTo(20);
  thought(
    MX,
    20.2,
    3,
    'The handler is asking whether the scuff could be deferred to protect the departure.',
    'Deferral is a certifying-staff decision; attempting it here is outside my authority.',
  );
  const forbiddenTc = call(MX, 20.4, 3, 'defer_defect', 'mne', 'forbidden', {
    defectId: 'def-1',
    melItem: '32-xx',
    reason: 'Handler request',
  });
  const block = r.push(
    'guardrail.blocked',
    20.4,
    agent('maintenance'),
    {
      layer: 'tier',
      tool: 'defer_defect',
      reason:
        'defer_defect is forbidden for software: deferral is reserved for certifying staff (Part-145). Nothing was changed.',
      toolCallId: forbiddenTc,
      ...FORBIDDEN.defer_defect,
    },
    env(MX, 3),
  );
  k.forbidden = 1;
  k.seqs.safety.push(block.seq);
  result(
    MX,
    20.4,
    3,
    forbiddenTc,
    'defer_defect',
    false,
    { error: 'forbidden_tier', message: 'Blocked by the autonomy matrix' },
    undefined,
    5,
  );
  thought(
    MX,
    20.7,
    4,
    'Blocked as expected. I will leave the deferral question to Ada Pennick and ask for her engineering decision once the inspection is done.',
  );
  r.kpiUpdate(20.8);

  r.advanceTo(22);
  r.push('world.process', 22, WORLD, {
    system: 'handler',
    entity: 'tasks',
    id: 'ht-2',
    change: 'Stairs acknowledged by handler',
  });
  r.patch(22, WORLD, 'handler', 'tasks', 'ht-2', { status: 'acknowledged' });
  r.patch(22, WORLD, 'airport', 'resourceRequests', 'rr-stairs-1', { status: 'confirmed' });
  r.patch(22, WORLD, 'mne', 'workOrders', 'wo-1', { progressPct: 60 });
  r.advanceTo(25);
  r.push('world.process', 25, WORLD, {
    system: 'airport',
    entity: 'resourceRequests',
    id: 'rr-stairs-1',
    change: 'Stairs on site at NW-KES',
  });
  r.patch(25, WORLD, 'airport', 'resourceRequests', 'rr-stairs-1', { status: 'on_site' });
  r.patch(25, WORLD, 'handler', 'tasks', 'ht-2', { status: 'done' });
  r.patch(25, WORLD, 'airport', 'resourceRequests', 'rr-bus-1', { status: 'en_route' });

  // ---- inspection finding (min 27)
  r.advanceTo(27);
  r.push('world.process', 27, WORLD, {
    system: 'airport',
    entity: 'resourceRequests',
    id: 'rr-bus-1',
    change: 'Buses at NW-KES; disembark under way',
  });
  r.patch(27, WORLD, 'airport', 'resourceRequests', 'rr-bus-1', { status: 'on_site' });
  r.advanceTo(28);
  r.push('world.process', 28, WORLD, {
    system: 'mne',
    entity: 'workOrders',
    id: 'wo-1',
    change: 'Inspection finding: torque-link bracket cracked, rectification about 150 min',
  });
  const finding = r.patch(28, WORLD, 'mne', 'workOrders', 'wo-1', {
    status: 'in_progress',
    progressPct: 100,
    task: 'Inspect nose landing gear after tug contact — finding: torque-link bracket cracked',
    estimatedDurationMin: 150,
  });
  r.patch(28, WORLD, 'mne', 'defects', 'def-1', {
    description: 'Nose landing gear torque-link bracket cracked after tug contact',
  });
  k.primaryDelay = 178;
  k.reactionary = 150;
  const d4 = r.patch(28.2, WORLD, 'occ', 'flights', 'NWD214', { delayMin: 178, etd: '2026-06-14T09:50:00Z' });
  r.patch(28.2, WORLD, 'occ', 'flights', 'NWD215', {
    status: 'delayed',
    delayMin: 0,
    reactionaryDelayMin: 95,
  });
  r.patch(28.2, WORLD, 'occ', 'flights', 'NWD230', { status: 'delayed', reactionaryDelayMin: 40 });
  r.patch(28.2, WORLD, 'occ', 'flights', 'NWD231', { status: 'delayed', reactionaryDelayMin: 15 });
  k.seqs.cost.push(finding.seq, d4.seq);
  k.seqs.sat.push(d4.seq);
  r.kpiUpdate(28.3);

  thought(
    MX,
    28.5,
    5,
    'Rectification is about 150 minutes: NW-KES will not make NWD214 before the 3-hour threshold.',
    'Reporting to the orchestrator so it can put the alternatives to the Duty Manager.',
  );
  t = call(MX, 28.7, 5, 'get_open_defects', 'mne', 'execute', { tail: 'NW-KES' });
  result(MX, 28.7, 5, t, 'get_open_defects', true, { defects: [{ id: 'def-1', status: 'open', ata: '32' }] });

  // ---- orchestrator: options decision (min 30)
  r.advanceTo(30);
  thought(
    ORCH,
    30.1,
    3,
    'Three real alternatives: swap to NW-LRM, hold for rectification, or cancel. The Duty Manager decides.',
    'Swap is fastest and keeps the PMI return; holding crosses the 3-hour threshold for 174 passengers.',
  );
  const decTc = call(ORCH, 30.3, 3, 'request_decision', 'runtime', 'propose', {
    question: 'How should NWD214 operate?',
  });
  r.push(
    'agent.proposal',
    30.3,
    agent('orchestrator'),
    {
      approvalId: 'ap-decision-1',
      toolCallId: decTc,
      tool: 'request_decision',
      args: { question: 'How should NWD214 operate?', flights: ['NWD214', 'NWD215'] },
      summary:
        'Choose how NWD214 operates: swap to spare NW-LRM (recommended), hold for rectification, or cancel.',
      reasoning:
        'The engineer’s finding needs about 150 minutes of rectification (a provisional reading until the certifying engineer decides). NW-LRM is free on stand 34 from 07:25Z, crew FDP has 10 h left, and a swap departs about 55 minutes late. Holding projects 178 minutes, at the EU261 3-hour threshold for 174 passengers. Cancelling triggers rebooking on the evening flight.',
      options: [
        {
          id: 'opt-swap',
          label: 'Swap NWD214/215 to spare NW-LRM (stand 34)',
          metrics: {
            timeToDepartureMin: 25,
            costEur: 13300,
            customerImpact: 24,
            compliant: true,
            constraints: ['Spare free from 07:25Z', 'Crew FDP OK (10 h left)'],
          },
          recommended: true,
          unresolvedChecks: ['Crew for NW-LRM confirmed by crew control'],
          approvalScope: {
            authorises:
              'Choosing “Swap NWD214/215 to spare NW-LRM” as the plan. Each action it leads to is proposed and approved separately.',
            doesNotAuthorise: ['Executing the swap: OCC confirms and executes it'],
          },
          dataAsOfMinute: 28.7,
        },
        {
          id: 'opt-hold',
          label: 'Hold NW-KES for rectification',
          metrics: {
            timeToDepartureMin: 150,
            costEur: 114400,
            customerImpact: 72,
            compliant: true,
            constraints: ['At the 3-hour threshold', 'Part availability unconfirmed'],
          },
          recommended: false,
          unresolvedChecks: ['Part availability from stores', 'Rectification time (provisional)'],
          dataAsOfMinute: 28.7,
        },
        {
          id: 'opt-cancel',
          label: 'Cancel NWD214 and rebook on NWD218',
          metrics: {
            timeToDepartureMin: 610,
            costEur: 61800,
            customerImpact: 90,
            compliant: true,
            constraints: ['Rebooking 16:40Z, 71 seats', 'Hotel for connections'],
          },
          recommended: false,
        },
      ],
      expiresAtMinute: 42,
      tier: 'propose',
      unresolvedChecks: ['Rectification time is a provisional reading until the certifying engineer decides'],
      approvalScope: SCOPE.request_decision,
      citations: [
        cite(
          'demo-ground-damage-note',
          'Demo note: ground damage inspection (fixture)',
          'Fixture text: any tug or towbar contact with a landing gear leg requires an inspection by certifying staff before the next flight.',
        ),
      ],
      dataAsOfMinute: 28.7,
    },
    env(ORCH, 3),
  );

  r.advanceTo(32);
  r.patch(32, WORLD, 'mne', 'workOrders', 'wo-1', { status: 'awaiting_certification' });
  // ---- record agent drafts the occurrence report while the decision is pending
  thought(
    REC,
    32.4,
    2,
    'Draft the occurrence report for the ramp occurrence; it is for a named human reporter to file.',
  );
  t = call(REC, 32.6, 2, 'draft_occurrence_report', 'record', 'execute', {
    kind: 'occurrence',
    tail: 'NW-KES',
  });
  const rep = r.put(32.6, agent('record'), 'record', 'reports', 'rep-1', {
    id: 'rep-1',
    kind: 'occurrence',
    body: 'DRAFT for a named reporter. On 14 June at 06:52Z during pushback of NW-KES (NWD214, MAN stand 32) the towbar shear pin failed and the tug contacted the nose landing gear. No injuries. Passengers disembarked on the apron by stairs and bus. Inspection found a cracked torque-link bracket; the aircraft is out of service pending rectification.',
    status: 'draft',
    forHumanReporter: true,
    aiDrafted: true,
    createdAtMinute: 32.6,
  });
  k.morDrafted = true;
  k.seqs.compliance.push(rep.seq);
  result(REC, 32.6, 2, t, 'draft_occurrence_report', true, { reportId: 'rep-1', status: 'draft' });

  r.advanceTo(35);
  r.push('world.process', 35, WORLD, {
    system: 'occ',
    entity: 'spares',
    id: 'NW-LRM',
    change: 'Spare NW-LRM available on stand 34',
  });
  r.patch(35, WORLD, 'airport', 'stands', '34', { occupiedUntilMinute: 35 });

  // ---- DM chooses the swap (recorded)
  r.advanceTo(36);
  const dec2 = r.push('approval.decision', 36.2, DM, {
    approvalId: 'ap-decision-1',
    decision: 'approve',
    selectedOptionId: 'opt-swap',
    decidedBy: DM,
  });
  k.humanDecisions += 1;
  k.swapDecisionMin = 36.2;
  k.seqs.latency.push(dec2.seq);
  result(ORCH, 36.3, 3, decTc, 'request_decision', true, {
    selectedOptionId: 'opt-swap',
    decidedBy: 'Sam Okafor (Duty Manager)',
  });
  // ---- flight ops sends the swap request (approving it SENDS A REQUEST to OCC; OCC confirms and executes)
  thought(OPS, 36.35, 3, 'The Duty Manager chose the swap; propose the swap request to OCC.');
  const swapTc = call(OPS, 36.4, 3, 'propose_swap', 'occ', 'propose', {
    fromTail: 'NW-KES',
    toTail: 'NW-LRM',
    flights: ['NWD214', 'NWD215'],
  });
  r.push(
    'agent.proposal',
    36.4,
    agent('flightops'),
    {
      approvalId: 'ap-swap-1',
      toolCallId: swapTc,
      tool: 'propose_swap',
      args: { fromTail: 'NW-KES', toTail: 'NW-LRM', flights: ['NWD214', 'NWD215'] },
      summary: 'Send the swap request to OCC: NW-LRM takes over NWD214 and NWD215 from NW-KES.',
      reasoning:
        'The Duty Manager chose the swap option. NW-LRM is on stand 34 and free from 07:25Z; the crew keep their duty margin. OCC confirms and executes the swap.',
      tier: 'propose',
      unresolvedChecks: [
        'Spare aircraft serviceability confirmed by maintenance control',
        'Crew for the swapped flights confirmed by crew control',
      ],
      approvalScope: SCOPE.propose_swap,
      dataAsOfMinute: 35,
      assumptions: [
        { key: 'spareAvailableFromMinute', value: 35, source: 'occ/spares/NW-LRM#availableFromMinute' },
      ],
    },
    env(OPS, 3),
  );
  const decSwap = r.push('approval.decision', 36.9, DM, {
    approvalId: 'ap-swap-1',
    decision: 'approve',
    decidedBy: DM,
  });
  k.humanDecisions += 1;
  const swap = r.put(
    36.95,
    DM,
    'occ',
    'swaps',
    'swap-1',
    {
      id: 'swap-1',
      fromTail: 'NW-KES',
      toTail: 'NW-LRM',
      flights: ['NWD214', 'NWD215'],
      status: 'requested',
      approvedBy: DM,
      requestedAtMinute: 36.95,
      confirmAtMinute: 41.95,
    },
    { causedBySeq: decSwap.seq, agentRunId: OPS, parentAgentRunId: ORCH },
  );
  result(OPS, 36.95, 3, swapTc, 'propose_swap', true, {
    swap: {
      id: 'swap-1',
      fromTail: 'NW-KES',
      toTail: 'NW-LRM',
      flights: ['NWD214', 'NWD215'],
      status: 'requested',
    },
    note: 'Swap request sent to OCC; OCC confirms and executes it (expected at minute 41.95).',
    expectedDepartureMinute: 60,
    expectedDelayMin: 58,
  });
  k.seqs.cost.push(dec2.seq, swap.seq);
  timeline(36.97, ORCH, 6, 'Duty Manager chose the swap to NW-LRM; swap request sent to OCC');
  r.kpiUpdate(36.98);

  // ---- ground: board from stand 34
  thought(
    GND,
    37.0,
    3,
    'Passengers are in the terminal; request stand 34 for boarding on NW-LRM and release the buses.',
  );
  t = call(GND, 37.2, 3, 'request_stand', 'airport', 'execute', { standId: '34', tail: 'NW-LRM' });
  r.put(37.2, agent('ground'), 'airport', 'standRequests', 'sr-1', {
    id: 'sr-1',
    standId: '34',
    tail: 'NW-LRM',
    status: 'requested',
    confirmAtMinute: 40,
  });
  result(GND, 37.2, 3, t, 'request_stand', true, { requestId: 'sr-1', confirmAtMinute: 40 });

  // ---- passenger: update message (edited by DM) + care vouchers
  thought(
    PAXA,
    37.5,
    3,
    'Tell passengers about the new aircraft and time; families and PRM have waited over 30 minutes, so propose refreshment vouchers.',
  );
  const msg2Body =
    'NWD214 to Palma: we are changing aircraft so you can travel sooner. New departure about 07:50 from gate 34. Refreshment vouchers are available at the gate for families and passengers needing assistance. Next update by 07:30.';
  t = call(PAXA, 37.7, 4, 'draft_passenger_message', 'pss', 'execute', {
    cohortIds: ALL_COHORTS,
    channel: 'sms',
  });
  r.put(37.7, agent('passenger'), 'pss', 'messages', 'msg-2', {
    id: 'msg-2',
    cohortIds: ALL_COHORTS,
    channel: 'sms',
    body: msg2Body,
    status: 'draft',
    aiDrafted: true,
  });
  result(PAXA, 37.7, 4, t, 'draft_passenger_message', true, { messageId: 'msg-2', screening: 'clean' });
  const sendTc2 = call(PAXA, 37.9, 4, 'send_passenger_message', 'pss', 'propose', {
    messageId: 'msg-2',
    cohortIds: ALL_COHORTS,
    channel: 'sms',
  });
  r.patch(37.9, agent('passenger'), 'pss', 'messages', 'msg-2', { status: 'pending_approval' });
  r.push(
    'agent.proposal',
    37.9,
    agent('passenger'),
    {
      approvalId: 'ap-msg-2',
      toolCallId: sendTc2,
      tool: 'send_passenger_message',
      args: {
        messageId: 'msg-2',
        cohortIds: ALL_COHORTS,
        channel: 'sms',
        body: msg2Body,
        requestId: req(sendTc2),
      },
      summary: 'Tell all 174 passengers about the aircraft change and the new departure time (about 07:50).',
      reasoning:
        'The swap request is with OCC. Passengers need the new time, the gate and the care offer. The next-update time keeps the information duty going.',
      expiresAtMinute: 48,
      tier: 'propose',
      unresolvedChecks: ['OCC has not yet confirmed the swap', 'Boarding time from stand 34'],
      approvalScope: SCOPE.send_passenger_message,
      dataAsOfMinute: 37.7,
    },
    env(PAXA, 4),
  );
  const careTc = call(PAXA, 38.2, 4, 'issue_care_vouchers', 'pss', 'propose', {
    cohortIds: ['c-families', 'c-prm', 'c-um'],
    kind: 'refreshment',
    valueEur: 8,
  });
  r.push(
    'agent.proposal',
    38.2,
    agent('passenger'),
    {
      approvalId: 'ap-care-1',
      toolCallId: careTc,
      tool: 'issue_care_vouchers',
      args: { cohortIds: ['c-families', 'c-prm', 'c-um'], kind: 'refreshment', valueEur: 8 },
      summary: 'Issue €8 refreshment vouchers to 16 passengers (families, PRM, unaccompanied minors).',
      reasoning:
        'These cohorts have waited on the apron and in the terminal for over 30 minutes. Care is a human decision; the value follows the carrier care policy.',
      tier: 'propose',
      unresolvedChecks: ['Vendors at the gate can honour the vouchers'],
      approvalScope: SCOPE.issue_care_vouchers,
      citations: [
        cite(
          'demo-pax-rights-note',
          'Demo note: passenger information duties (fixture)',
          'Fixture text: passengers must be informed of their rights and of the expected delay as early as possible.',
        ),
      ],
      dataAsOfMinute: 37.7,
    },
    env(PAXA, 4),
  );

  r.advanceTo(40);
  r.push('world.process', 40, WORLD, {
    system: 'airport',
    entity: 'standRequests',
    id: 'sr-1',
    change: 'Stand 34 confirmed for NW-LRM',
  });
  r.patch(40, WORLD, 'airport', 'standRequests', 'sr-1', { status: 'confirmed' });
  r.patch(40, WORLD, 'airport', 'resourceRequests', 'rr-bus-1', { status: 'released' });

  // ---- DM edits the message (adds the gate time) and approves care
  r.advanceTo(41);
  const edited = {
    requestId: req(sendTc2),
    messageId: 'msg-2',
    cohortIds: ALL_COHORTS,
    channel: 'sms',
    body: msg2Body.replace('about 07:50 from gate 34', 'about 07:50 from gate 34 (boarding from 07:30)'),
  };
  const dec3 = r.push('approval.decision', 41.3, DM, {
    approvalId: 'ap-msg-2',
    decision: 'edit',
    editedArgs: edited,
    reason: 'Add the boarding time.',
    decidedBy: DM,
  });
  k.humanDecisions += 1;
  r.patch(
    41.3,
    agent('passenger'),
    'pss',
    'messages',
    'msg-2',
    { body: edited.body, status: 'sent', sentAtMinute: 41.3, approvedBy: DM },
    { causedBySeq: dec3.seq },
  );
  result(PAXA, 41.4, 4, sendTc2, 'send_passenger_message', true, {
    messageId: 'msg-2',
    delivered: 174,
    edited: true,
  });

  // ---- OCC confirms and executes the swap request (modelled process)
  r.push('world.process', 41.95, WORLD, {
    system: 'occ',
    entity: 'swaps',
    id: 'swap-1',
    change: 'OCC confirmed and executed the swap: NWD214/215 re-tailed to NW-LRM',
  });
  const swapDone = r.put(
    41.95,
    WORLD,
    'occ',
    'swaps',
    'swap-1',
    {
      id: 'swap-1',
      fromTail: 'NW-KES',
      toTail: 'NW-LRM',
      flights: ['NWD214', 'NWD215'],
      status: 'executed',
      approvedBy: DM,
      requestedAtMinute: 36.95,
      confirmAtMinute: 41.95,
      occNote: 'Confirmed and executed by OCC at minute 42',
    },
    { causedBySeq: decSwap.seq },
  );
  r.patch(41.95, WORLD, 'occ', 'spares', 'NW-LRM', { assignedTo: 'NWD214' }, { causedBySeq: decSwap.seq });
  k.primaryDelay = 58;
  k.reactionary = 25;
  const f1 = r.patch(
    41.95,
    WORLD,
    'occ',
    'flights',
    'NWD214',
    { tail: 'NW-LRM', status: 'delayed', delayMin: 58, etd: '2026-06-14T07:50:00Z' },
    { causedBySeq: decSwap.seq },
  );
  r.patch(
    41.95,
    WORLD,
    'occ',
    'flights',
    'NWD215',
    { tail: 'NW-LRM', status: 'delayed', delayMin: 0, reactionaryDelayMin: 25 },
    { causedBySeq: decSwap.seq },
  );
  r.patch(
    41.95,
    WORLD,
    'occ',
    'flights',
    'NWD230',
    { status: 'scheduled', reactionaryDelayMin: 0 },
    { causedBySeq: decSwap.seq },
  );
  r.patch(
    41.95,
    WORLD,
    'occ',
    'flights',
    'NWD231',
    { status: 'scheduled', reactionaryDelayMin: 0 },
    { causedBySeq: decSwap.seq },
  );
  k.seqs.cost.push(swapDone.seq, f1.seq);
  k.seqs.sat.push(f1.seq);
  r.kpiUpdate(41.97);
  const dec4 = r.push('approval.decision', 42.0, DM, {
    approvalId: 'ap-care-1',
    decision: 'approve',
    decidedBy: DM,
  });
  k.humanDecisions += 1;
  for (const [i, c] of (['c-families', 'c-prm', 'c-um'] as const).entries()) {
    r.put(
      42.1,
      agent('passenger'),
      'pss',
      'vouchers',
      `v-${i + 1}`,
      { id: `v-${i + 1}`, cohortId: c, kind: 'refreshment', valueEur: 8, issuedAtMinute: 42.1 },
      { causedBySeq: dec4.seq },
    );
    r.patch(
      42.1,
      agent('passenger'),
      'pss',
      'cohorts',
      c,
      { status: 'care_issued', careIssued: r.get<{ count: number }>('pss', 'cohorts', c)!.count },
      { causedBySeq: dec4.seq },
    );
  }
  result(PAXA, 42.2, 4, careTc, 'issue_care_vouchers', true, { vouchers: 3, pax: 16 });
  k.careActions = 1;
  k.carePax = 16;
  k.careFromMin = 42.1;
  k.seqs.sat.push(dec4.seq);
  k.seqs.cost.push(dec4.seq);
  r.kpiUpdate(42.3);

  // ---- maintenance: engineering decision needs the certifying engineer
  r.advanceTo(44);
  thought(
    MX,
    44.1,
    6,
    'Ada Pennick has finished the inspection; her rectify decision must be recorded against her name.',
  );
  const engTc = call(MX, 44.3, 6, 'record_engineering_decision', 'mne', 'propose', {
    tail: 'NW-KES',
    decision: 'rectify',
  });
  r.push(
    'agent.proposal',
    44.3,
    agent('maintenance'),
    {
      approvalId: 'ap-eng-1',
      toolCallId: engTc,
      tool: 'record_engineering_decision',
      args: {
        tail: 'NW-KES',
        decision: 'rectify',
        rationale: 'Cracked torque-link bracket; replace before next flight.',
      },
      summary: 'Record the certifying engineer’s decision: rectify NW-KES (replace the torque-link bracket).',
      reasoning:
        'Only certifying staff may decide rectify, defer or release. This records Ada Pennick’s decision so the work order and stores request can proceed.',
      tier: 'propose',
      unresolvedChecks: ['Inspection completed and signed by certifying staff'],
      approvalScope: SCOPE.record_engineering_decision,
      citations: [
        cite(
          'demo-ground-damage-note',
          'Demo note: ground damage inspection (fixture)',
          'Fixture text: any tug or towbar contact with a landing gear leg requires an inspection by certifying staff before the next flight.',
        ),
      ],
      dataAsOfMinute: 32,
    },
    env(MX, 6),
  );

  r.advanceTo(46);
  r.push('world.process', 46, WORLD, {
    system: 'occ',
    entity: 'flights',
    id: 'NWD214',
    change: 'Boarding NWD214 on NW-LRM at stand 34',
  });
  r.patch(46, WORLD, 'occ', 'flights', 'NWD214', { status: 'boarding' });
  const dec5 = r.push('approval.decision', 47.5, CERT, {
    approvalId: 'ap-eng-1',
    decision: 'approve',
    decidedBy: CERT,
  });
  k.humanDecisions += 1;
  k.engDecisionMin = 47.5;
  k.seqs.latency.push(dec5.seq);
  k.seqs.safety.push(dec5.seq);
  r.put(
    47.6,
    agent('maintenance'),
    'mne',
    'decisions',
    'ed-1',
    {
      id: 'ed-1',
      tail: 'NW-KES',
      decision: 'rectify',
      decidedBy: CERT,
      atMinute: 47.5,
      rationale: 'Cracked torque-link bracket; replace before next flight.',
    },
    { causedBySeq: dec5.seq },
  );
  result(MX, 47.6, 6, engTc, 'record_engineering_decision', true, {
    decisionId: 'ed-1',
    decidedBy: 'Ada Pennick (Certifying Engineer (B1))',
  });
  r.put(
    47.8,
    agent('maintenance'),
    'mne',
    'techlog',
    'tlg-1',
    {
      id: 'tlg-1',
      tail: 'NW-KES',
      text: 'NLG torque-link bracket found cracked following tug contact on pushback. Rectification decided by the certifying engineer; replacement bracket requested from stores. (Draft for certifying engineer.)',
      status: 'draft',
      aiDrafted: true,
    },
    { causedBySeq: dec5.seq },
  );
  r.kpiUpdate(48);

  // ---- reports from specialists
  r.advanceTo(50);
  r.push(
    'agent.report',
    50.2,
    agent('ground'),
    {
      role: 'ground',
      report: {
        summary:
          'Passengers disembarked by stairs and bus while no tug was available; stand 34 confirmed for NW-LRM.',
        actionsTaken: ['Tow requested', 'Two buses and stairs', 'Stand 34 requested and confirmed'],
        openIssues: ['Tow NW-KES to the hangar when a tug is free'],
        recommendations: ['Keep one tug in reserve during the morning wave'],
        citations: [],
      },
    },
    env(GND, 4),
  );
  r.push(
    'agent.report',
    50.6,
    agent('flightops'),
    {
      role: 'flightops',
      report: {
        summary: 'NWD214/215 swapped to NW-LRM; NWD230/231 protected on the original schedule.',
        actionsTaken: [
          'Rotation and FDP checked',
          'Spare identified',
          'Swap request sent to OCC after the Duty Manager’s decision; OCC executed it',
        ],
        openIssues: [],
        recommendations: ['Plan NW-KES back into the rotation after rectification'],
        citations: [],
      },
    },
    env(OPS, 3),
  );

  r.advanceTo(54);
  r.push('world.process', 54, WORLD, {
    system: 'occ',
    entity: 'flights',
    id: 'NWD214',
    change: 'NWD214 pushed back on NW-LRM',
  });
  k.resolved = true;
  const dep = r.patch(54, WORLD, 'occ', 'flights', 'NWD214', { status: 'departed', delayMin: 58 });
  k.seqs.compliance.push(dep.seq);
  timeline(54.2, REC, 7, 'NWD214 departed on NW-LRM, 58 minutes late');
  r.kpiUpdate(54.3);

  r.push(
    'agent.report',
    55.0,
    agent('passenger'),
    {
      role: 'passenger',
      report: {
        summary:
          'Two messages sent to 174 passengers (first at minute 6.4); refreshment vouchers for 16 passengers.',
        actionsTaken: [
          'First message approved and sent',
          'Update message edited by the Duty Manager and sent',
          'Care vouchers issued',
        ],
        openIssues: ['Connections at PMI: onward deadline 12:30Z still achievable'],
        recommendations: [],
        citations: [
          cite(
            'demo-pax-rights-note',
            'Demo note: passenger information duties (fixture)',
            'Fixture text: passengers must be informed of their rights and of the expected delay as early as possible.',
          ),
        ],
      },
    },
    env(PAXA, 5),
  );
  r.push(
    'agent.report',
    55.4,
    agent('maintenance'),
    {
      role: 'maintenance',
      report: {
        summary:
          'Cracked torque-link bracket found on NW-KES; rectification decided and recorded by the certifying engineer.',
        actionsTaken: [
          'Engineer paged at minute 3.5',
          'Work order wo-1',
          'Engineering decision recorded (Ada Pennick)',
        ],
        openIssues: ['Bracket from stores; ETA to be confirmed'],
        recommendations: ['Review towbar shear pin stock'],
        provisionalReading: {
          text: 'Torque-link bracket crack consistent with a towing overload; about 150 minutes to replace, pending the certifying engineer’s own assessment.',
          confidence: 'medium',
          unconfirmed: true,
        },
        recommendationDetails: [
          {
            text: 'Review towbar shear pin stock',
            unresolvedChecks: ['Shear pin batch and failure mode not yet examined'],
            approvalScope: SCOPE.recommendation,
            dataAsOfMinute: 55.4,
          },
        ],
        citations: [
          cite(
            'demo-ground-damage-note',
            'Demo note: ground damage inspection (fixture)',
            'Fixture text: any tug or towbar contact with a landing gear leg requires an inspection by certifying staff before the next flight.',
          ),
        ],
      },
    },
    env(MX, 7),
  );

  // ---- record: evidence pack
  r.advanceTo(56);
  t = call(REC, 56.2, 3, 'export_evidence_pack', 'record', 'execute', { incidentId: 'inc-s01-1' });
  r.put(56.3, agent('record'), 'record', 'evidencePacks', 'ep-1', {
    id: 'ep-1',
    createdAtMinute: 56.3,
    contents: {
      timeline: Object.values(r.state.record?.timeline ?? {}),
      decisions: [
        {
          approvalId: 'ap-msg-1',
          tool: 'send_passenger_message',
          decision: 'approve',
          decidedBy: DM,
          atMinute: 6.4,
        },
        {
          approvalId: 'ap-decision-1',
          tool: 'request_decision',
          decision: 'approve',
          selectedOptionId: 'opt-swap',
          decidedBy: DM,
          atMinute: 36.2,
        },
        {
          approvalId: 'ap-swap-1',
          tool: 'propose_swap',
          decision: 'approve',
          decidedBy: DM,
          atMinute: 36.9,
        },
        {
          approvalId: 'ap-msg-2',
          tool: 'send_passenger_message',
          decision: 'edit',
          decidedBy: DM,
          atMinute: 41.3,
        },
        {
          approvalId: 'ap-care-1',
          tool: 'issue_care_vouchers',
          decision: 'approve',
          decidedBy: DM,
          atMinute: 42,
        },
        {
          approvalId: 'ap-eng-1',
          tool: 'record_engineering_decision',
          decision: 'approve',
          decidedBy: CERT,
          atMinute: 47.5,
        },
      ],
      messages: Object.values(r.state.pss?.messages ?? {}),
      reports: Object.values(r.state.record?.reports ?? {}),
      citations: [
        cite(
          'demo-ground-damage-note',
          'Demo note: ground damage inspection (fixture)',
          'Fixture text: any tug or towbar contact with a landing gear leg requires an inspection by certifying staff before the next flight.',
        ),
        cite(
          'demo-pax-rights-note',
          'Demo note: passenger information duties (fixture)',
          'Fixture text: passengers must be informed of their rights and of the expected delay as early as possible.',
        ),
      ],
    },
  });
  result(REC, 56.3, 3, t, 'export_evidence_pack', true, { evidencePackId: 'ep-1' });
  r.push(
    'agent.report',
    56.8,
    agent('record'),
    {
      role: 'record',
      report: {
        summary:
          'Timeline kept; occurrence report drafted for a named reporter; evidence pack ep-1 exported.',
        actionsTaken: ['7 timeline entries', 'Occurrence report draft rep-1', 'Evidence pack ep-1'],
        openIssues: ['Occurrence report to be filed by a named person within 72 h'],
        recommendations: [],
        citations: [],
      },
    },
    env(REC, 4),
  );

  r.advanceTo(58);
  thought(
    ORCH,
    58.1,
    4,
    'All specialists have reported; NWD214 is airborne on NW-LRM and the open issues are with named humans.',
  );
  r.push(
    'agent.report',
    58.4,
    agent('orchestrator'),
    {
      role: 'orchestrator',
      report: {
        summary:
          'NWD214 departed 58 minutes late on spare NW-LRM after the Duty Manager chose the swap and OCC executed it; NW-KES is out of service for the rectification the certifying engineer decided. Passengers informed at minute 6.4.',
        actionsTaken: [
          'Incident opened and specialists briefed in parallel',
          'Options decision put to the Duty Manager',
          'Evidence pack exported',
        ],
        openIssues: ['Occurrence report to be filed by a named person', 'NW-KES bracket from stores'],
        recommendations: ['Review tug reserve policy for the morning wave'],
        citations: [],
        recommendationDetails: [
          {
            text: 'Review tug reserve policy for the morning wave',
            unresolvedChecks: ['Handler staffing and tug availability data for the morning wave'],
            approvalScope: SCOPE.recommendation,
            dataAsOfMinute: 58.4,
          },
        ],
      },
    },
    env(ORCH, 5),
  );
  const finalKpis = r.kpiUpdate(58.6).payload;
  const totals = r.events.reduce(
    (acc, e) => {
      if (e.usage) {
        acc.inputTokens += e.usage.inputTokens;
        acc.outputTokens += e.usage.outputTokens;
        acc.costUsd = +(acc.costUsd + e.usage.costUsd).toFixed(6);
      }
      if (e.type === 'agent.tool_call') acc.toolCalls += 1;
      if (e.type === 'agent.thought') acc.iterations += 1;
      return acc;
    },
    { inputTokens: 0, outputTokens: 0, costUsd: 0, toolCalls: 0, iterations: 0, wallMs: 353_000 },
  );
  r.push('run.completed', 58.8, WORLD, { reason: 'report', totals, finalKpis });
  return r.events;
}

// ------------------------------------------------------------------------------------------------ baseline run
export function buildS01Baseline(): RunEvent[] {
  const r = new Recorder(
    S01_BASELINE_RUN,
    s01Scenario,
    Date.parse('2026-06-14T09:20:00Z'),
    kpiState(s01Scenario, PAX, 400),
  );
  const k = r.kpi;
  r.kpiEvery = 3;
  const B = { agentRunId: 'baseline' };
  const act = (m: number, actor: string, tool: string, args: Record<string, unknown>, note: string) =>
    r.push('baseline.action', m, human(actor, actor), { actor, tool, args, note }, B);

  r.push('run.created', 0, human('Baseline policy', 'Scripted human team'), {
    scenarioId: s01Scenario.id,
    mode: 'baseline',
    pairedRunId: S01_AGENT_RUN,
    speed: 6,
    config: { provider: 'scripted', model: 'baseline-policy', limits: DEFAULT_RUN_LIMITS },
  });
  r.push('run.started', 0, WORLD, { speed: 6 });
  seedWorld(r);
  r.kpiUpdate(0);
  r.advanceTo(2);
  r.push('world.process', 2, WORLD, {
    system: 'mne',
    entity: 'defects',
    id: 'def-1',
    change: 'Nose-gear contact reported by the pushback crew',
  });
  const trig = r.put(2, WORLD, 'mne', 'defects', 'def-1', {
    id: 'def-1',
    tail: 'NW-KES',
    description: 'Tug contact with nose landing gear during pushback (towbar shear pin failure)',
    ata: '32',
    status: 'open',
    raisedAtMinute: 2,
  });
  r.patch(2, WORLD, 'mne', 'aircraft', 'NW-KES', { status: 'unserviceable' });
  k.primaryDelay = 45;
  k.reactionary = 30;
  r.patch(2, WORLD, 'occ', 'flights', 'NWD214', { status: 'delayed', delayMin: 45 });
  k.seqs.cost.push(trig.seq);

  r.advanceTo(10);
  const pg = act(
    10,
    'Maintenance control',
    'page_engineer',
    { engineerId: 'eng-1', tail: 'NW-KES' },
    'Engineer called by phone after the ramp report.',
  );
  r.patch(
    10,
    human('Maintenance control', 'Maintenance control'),
    'engineers',
    'engineers',
    'eng-1',
    { status: 'travelling', etaMinute: 20, travelMode: 'drive', destination: 'MAN' },
    { causedBySeq: pg.seq },
  );
  k.seqs.latency.push(pg.seq);
  r.advanceTo(14);
  act(14, 'Ramp supervisor', 'request_tow', { tail: 'NW-KES', standId: '32' }, 'Tow requested by radio.');
  r.put(14, human('Ramp supervisor', 'Ramp supervisor'), 'airport', 'resourceRequests', 'rr-tow-1', {
    id: 'rr-tow-1',
    kind: 'tow',
    station: 'MAN',
    status: 'requested',
    etaMinute: 24,
  });
  r.advanceTo(18);
  const tw = r.push('world.twist', 18, WORLD, {
    twistId: 'tw-second-tug',
    title: 'Second tug unavailable',
    description: s01Scenario.twists[0]!.description,
    source: 'scheduled',
    effects: s01Scenario.twists[0]!.effects,
  });
  r.patch(18, WORLD, 'handler', 'equipment', 'MAN:tug', { available: 0 }, { causedBySeq: tw.seq });
  k.primaryDelay = 110;
  k.reactionary = 90;
  r.patch(18, WORLD, 'occ', 'flights', 'NWD214', { delayMin: 110 }, { causedBySeq: tw.seq });
  k.seqs.cost.push(tw.seq);
  r.advanceTo(20);
  r.push('world.process', 20, WORLD, {
    system: 'engineers',
    entity: 'engineers',
    id: 'eng-1',
    change: 'Engineer on site at NW-KES',
  });
  r.patch(20, WORLD, 'engineers', 'engineers', 'eng-1', { status: 'on_site' });
  r.advanceTo(28);
  const msg = act(
    28,
    'Passenger services',
    'send_passenger_message',
    { cohortIds: ALL_COHORTS, channel: 'sms' },
    'First message after the gate announcement.',
  );
  r.put(
    28,
    human('Passenger services', 'Passenger services'),
    'pss',
    'messages',
    'msg-b1',
    {
      id: 'msg-b1',
      cohortIds: ALL_COHORTS,
      channel: 'sms',
      body: 'NWD214 is delayed due to a technical issue. Further information to follow.',
      status: 'sent',
      aiDrafted: true,
      sentAtMinute: 28,
      approvedBy: human('Passenger services', 'Passenger services'),
    },
    { causedBySeq: msg.seq },
  );
  for (const c of ALL_COHORTS)
    r.patch(
      28,
      WORLD,
      'pss',
      'cohorts',
      c,
      { status: 'informed', firstInformedAtMinute: 28 },
      { causedBySeq: msg.seq },
    );
  k.firstMsgMin = 28;
  k.seqs.sat.push(msg.seq);
  k.seqs.compliance.push(msg.seq);
  k.seqs.latency.push(msg.seq);
  r.kpiUpdate(28.2);
  r.advanceTo(38);
  r.push('world.process', 38, WORLD, {
    system: 'mne',
    entity: 'workOrders',
    id: 'wo-b1',
    change: 'Inspection finding: torque-link bracket cracked',
  });
  r.patch(38, WORLD, 'mne', 'aircraft', 'NW-KES', { status: 'aog' });
  k.primaryDelay = 190;
  k.reactionary = 170;
  const d = r.patch(38, WORLD, 'occ', 'flights', 'NWD214', { delayMin: 190 });
  k.seqs.cost.push(d.seq);
  r.kpiUpdate(38.2);
  r.advanceTo(50);
  const sw = act(
    50,
    'OCC controller',
    'propose_swap',
    { fromTail: 'NW-KES', toTail: 'NW-LRM', flights: ['NWD214', 'NWD215'] },
    'Swap agreed once engineering gave an estimate.',
  );
  r.put(
    50,
    human('OCC controller', 'OCC controller'),
    'occ',
    'swaps',
    'swap-b1',
    {
      id: 'swap-b1',
      fromTail: 'NW-KES',
      toTail: 'NW-LRM',
      flights: ['NWD214', 'NWD215'],
      status: 'approved',
      approvedBy: human('OCC controller', 'OCC controller'),
    },
    { causedBySeq: sw.seq },
  );
  k.primaryDelay = 88;
  k.reactionary = 60;
  k.swapDecisionMin = 50;
  k.humanDecisions += 1;
  const f = r.patch(
    50,
    WORLD,
    'occ',
    'flights',
    'NWD214',
    { tail: 'NW-LRM', delayMin: 88 },
    { causedBySeq: sw.seq },
  );
  r.patch(
    50,
    WORLD,
    'occ',
    'flights',
    'NWD215',
    { tail: 'NW-LRM', status: 'delayed', reactionaryDelayMin: 60 },
    { causedBySeq: sw.seq },
  );
  k.seqs.cost.push(sw.seq, f.seq);
  k.seqs.latency.push(sw.seq);
  r.kpiUpdate(50.2);
  r.advanceTo(58);
  const care = act(
    58,
    'Passenger services',
    'issue_care_vouchers',
    { cohortIds: ['c-families', 'c-prm'], kind: 'refreshment' },
    'Refreshment vouchers at the gate.',
  );
  k.careActions = 1;
  k.carePax = 14;
  k.careFromMin = 58;
  k.seqs.sat.push(care.seq);
  r.advanceTo(70);
  const eng = act(
    70,
    'Duty engineer',
    'record_engineering_decision',
    { tail: 'NW-KES', decision: 'rectify' },
    'Rectification logged after the swap.',
  );
  k.engDecisionMin = 70;
  k.humanDecisions += 1;
  k.seqs.latency.push(eng.seq);
  r.advanceTo(84);
  r.push('world.process', 84, WORLD, {
    system: 'occ',
    entity: 'flights',
    id: 'NWD214',
    change: 'NWD214 pushed back on NW-LRM',
  });
  k.resolved = true;
  r.patch(84, WORLD, 'occ', 'flights', 'NWD214', { status: 'departed' });
  const finalKpis = r.kpiUpdate(84.2).payload;
  r.push('run.completed', 84.5, WORLD, {
    reason: 'horizon',
    totals: { inputTokens: 0, outputTokens: 0, costUsd: 0, toolCalls: 0, iterations: 0, wallMs: 510_000 },
    finalKpis,
  });
  return r.events;
}
