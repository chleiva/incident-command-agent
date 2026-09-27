/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Headlines (task 08): one template per tool in the registry (domain + runtime + the Scenario Author's patch tool),
 * at most 60 characters with realistic long arguments, and never an internal id, a tool name or a parameter name.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { RunEvent } from '@ica/schema/browser';
import { describe, expect, it } from 'vitest';
import { RECORDINGS } from '../mocks/recordings';
import { buildAgentsShowcase } from '../mocks/agentsShowcase';
import { HEADLINE_MAX, HEADLINE_TEMPLATES, TOOL_LABEL, clipText, headline, resultData } from './headline';

const RUN = resolve(process.cwd(), '../../services/run');

/** Every tool the runtime can call: one module per domain tool, plus the runtime tools. */
function registryToolNames(): string[] {
  const domain = readdirSync(resolve(RUN, 'tools'))
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.startsWith('_') && f !== 'index.ts')
    .map((f) => f.replace(/\.ts$/, ''));
  const runtimeSrc = readFileSync(resolve(RUN, 'runtime/tools.ts'), 'utf8');
  const block = /RUNTIME_TOOL_NAMES\s*=\s*\[([^\]]*)\]/.exec(runtimeSrc)?.[1] ?? '';
  const runtime = [...block.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
  return [...new Set([...domain, ...runtime])];
}

/** Domain tool names as registered (`name: '…'`), to catch a file whose tool is named differently. */
function registeredDomainNames(): string[] {
  return readdirSync(resolve(RUN, 'tools'))
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.startsWith('_') && f !== 'index.ts')
    .flatMap((f) => {
      const src = readFileSync(resolve(RUN, 'tools', f), 'utf8');
      return [...src.matchAll(/^\s+name:\s*'([a-z0-9_]+)'/gm)].map((m) => m[1]!);
    });
}

const LONG =
  'Nose landing gear contact during pushback with the tug; torque link and steering collar need a close look before any further movement of the aircraft on stand';

/** Realistic long arguments for any tool (unknown keys are ignored by the templates). */
const LONG_ARGS: Record<string, unknown> = {
  title: LONG,
  summary: LONG,
  objective: LONG,
  question: LONG,
  text: LONG,
  body: LONG,
  brief: LONG,
  query: LONG,
  role: 'flightops',
  options: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }],
  openIssues: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'],
  tail: 'AX-KES',
  fromTail: 'AX-KES',
  toTail: 'AX-LRM',
  flight: 'ACX214',
  toFlight: 'ACX216',
  flights: ['ACX214', 'ACX215', 'ACX230', 'ACX231'],
  station: 'MAN',
  airport: 'LYS',
  standId: 'R17',
  toStandId: 'R17',
  task: 'door_inspection_and_rigging_check',
  kind: 'damage_inspection_access',
  channel: 'email',
  cohortIds: ['c-general', 'c-families', 'c-prm', 'c-um', 'c-connections', 'c-premium'],
  services: ['fire_standby', 'medical', 'police', 'handling', 'stairs', 'disembark', 'hotel_hold'],
  decision: 'defer_mel',
  rationale: LONG,
  minutes: 120,
  count: 12,
  estimatedDurationMin: 480,
  engineerId: 'eng-123456',
  requestId: '781c0156-0000-4000-8000-000000000010',
  workOrderId: 'WO-001-3nf',
  defectId: 'def-1',
  messageId: 'MSG-001-epj',
  crewId: 'crew-cpt-1',
  standbyId: 'crew-sb-2',
  replacesCrewId: 'crew-fo-1',
  cohortId: 'c131-general',
  melItem: '32-11-01',
};

const LONG_RESULTS: Record<string, unknown> = {
  aircraft: { tail: 'AX-KES', status: 'unserviceable' },
  count: 1234,
  defects: [],
  etaMinute: 1234.5,
  name: 'Maximilian Featherstonehaugh-Worthington',
  label: LONG,
  hits: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
  stands: [{ free: true }, { free: false }],
  buses: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  flights: Array.from({ length: 18 }, (_, i) => `ACX${100 + i}`),
  candidates: [{ tail: 'AX-LRM', station: 'MAN', feasible: true }],
  feasibleCount: 12,
  assigned: { name: 'Maximilian Featherstonehaugh-Worthington' },
  totalPassengers: 18_000,
  totalEur: 1_234_567,
  cohort: { kind: 'unaccompanied_minors' },
  counts: { timeline: 1234 },
  phase: 'approach',
  options: [{ iata: 'MAN' }, { iata: 'LPL' }, { iata: 'LBA' }, { iata: 'EMA' }, { iata: 'BHX' }],
  valid: false,
  errors: Array.from({ length: 40 }, () => 'x'),
  status: 'sent',
};

const TOOLS = registryToolNames();

describe('people-facing headlines: who and why (demo review 2)', () => {
  const PAGE = { engineerId: 'eng-man-b1c', station: 'PMI', requestId: 'b2c3d4e5-f6a7-4890-b123' };
  it('a page names the engineer, the licence and the ETA', () => {
    expect(
      headline(
        'page_engineer',
        PAGE,
        { engineerId: 'eng-man-b1c', name: 'Tamsin Pennick', licence: 'B1', etaMinute: 275, travel: 'fly' },
        { minute: 8.5 },
      ),
    ).toBe('Paged Tamsin Pennick (B1) — ETA m275');
    expect(headline('page_engineer', PAGE)).toBe('Paging an engineer to PMI');
  });

  it('a failed page says who and why, never "Paged…"', () => {
    const busy = {
      notPaged: true,
      engineerId: 'eng-ibz-b1',
      name: 'Ari Voss',
      licence: 'B1',
      reason: 'busy',
      busyUntilMinute: 90,
      alternatives: [{ engineerId: 'eng-pmi-b2', name: 'Sol Larkstead' }],
    };
    const failed = { minute: 9, failed: true };
    expect(headline('page_engineer', PAGE, busy, failed)).toBe('Could not page Ari Voss — busy until m90');
    expect(headline('page_engineer', PAGE, { ...busy, retryRefused: true }, failed)).toBe(
      'Did not re-page Ari Voss — busy until m90',
    );
    // An older failure with only the error text (the live run's wording).
    expect(
      headline('page_engineer', PAGE, undefined, {
        ...failed,
        error: 'eng-ibz-b1 is busy until minute 90; page another engineer',
      }),
    ).toBe('Could not page an engineer — busy until m90');
    expect(headline('page_engineer', PAGE, undefined, failed)).toBe('Could not page an engineer');
    // Other tools: a failure never reads as success.
    expect(headline('request_stand', { standId: '12', tail: 'AX-KES' }, undefined, failed)).toBe(
      'Could not request a stand',
    );
    // Forbidden tools keep "Tried to…".
    expect(headline('defer_defect', {}, undefined, failed)).toBe('Tried to defer a defect under the MEL');
  });

  it('long names are clipped, the facts around them are kept (≤ 60, no ids)', () => {
    const long = 'Maximilian Featherstonehaugh-Worthington of Little Snoring';
    const ok = headline('page_engineer', PAGE, { name: long, licence: 'B1', etaMinute: 1275 }, { minute: 3 });
    expect(ok.length).toBeLessThanOrEqual(HEADLINE_MAX);
    expect(ok).toMatch(/^Paged Maximilian .*… \(B1\) — ETA m1275$/);
    const ko = headline(
      'page_engineer',
      PAGE,
      { name: long, reason: 'busy', busyUntilMinute: 1090, retryRefused: true },
      { failed: true },
    );
    expect(ko.length).toBeLessThanOrEqual(HEADLINE_MAX);
    expect(ko).toMatch(/— busy until m1090$/);
    for (const h of [ok, ko]) expect(h).not.toMatch(/eng-|_/);
  });
});

describe('headline templates', () => {
  it('exist for every tool in the registry (domain + runtime)', () => {
    expect(TOOLS.length).toBeGreaterThanOrEqual(54);
    const missing = TOOLS.filter((t) => !HEADLINE_TEMPLATES[t]);
    expect(missing).toEqual([]);
    const unlabelled = TOOLS.filter((t) => !TOOL_LABEL[t]);
    expect(unlabelled).toEqual([]);
    // Each module registers the tool its file is named after.
    for (const name of registeredDomainNames().filter((n) => n.includes('_')))
      expect(HEADLINE_TEMPLATES[name], name).toBeDefined();
  });

  it('are 60 characters or fewer, with realistic long arguments and results', () => {
    for (const tool of [...TOOLS, 'unknown_tool']) {
      const variants = [
        headline(tool, {}),
        headline(tool, LONG_ARGS),
        headline(tool, LONG_ARGS, LONG_RESULTS, { minute: 3 }),
        headline(tool, LONG_ARGS, LONG_RESULTS, { failed: true }),
        headline(tool, undefined, 'not an object'),
      ];
      for (const h of variants) {
        expect(h.length, `${tool}: ${h}`).toBeLessThanOrEqual(HEADLINE_MAX);
        expect(h.trim().length, tool).toBeGreaterThan(0);
      }
    }
  });

  it('never show internal ids, tool names or parameter names', () => {
    const toolNames = new Set(TOOLS);
    const check = (h: string, args: Record<string, unknown>, extra: string[] = []) => {
      // snake_case (every multi-word tool name, every snake parameter) and camelCase (parameter names).
      expect(h, h).not.toMatch(/\b[a-z0-9]+_[a-z0-9_]+\b/);
      expect(h, h).not.toMatch(/\b[a-z]+[A-Z][A-Za-z]*\b/);
      expect(h, h).not.toMatch(/toolu_|[0-9a-f]{8}-[0-9a-f]{4}-/i);
      for (const t of toolNames) if (t.includes('_')) expect(h).not.toContain(t);
      for (const [k, v] of Object.entries(args)) {
        if (k === 'standId' || k === 'toStandId') continue; // a stand is a human-meaningful identifier
        if (!/(Id|Ids)$/.test(k)) continue;
        for (const id of (Array.isArray(v) ? v : [v]).map(String))
          expect(h, `${k} in "${h}"`).not.toContain(id);
      }
      for (const id of extra) expect(h, h).not.toContain(id);
    };
    for (const tool of TOOLS) check(headline(tool, LONG_ARGS, LONG_RESULTS, { minute: 3 }), LONG_ARGS);
    const events: RunEvent[] = [
      ...RECORDINGS.flatMap((r) => [...r.agent, ...r.baseline]),
      ...buildAgentsShowcase(),
    ];
    const results = new Map<string, RunEvent<'agent.tool_result'>>();
    for (const e of events)
      if (e.type === 'agent.tool_result') results.set(`${e.runId}/${e.payload.toolCallId}`, e);
    let checked = 0;
    for (const e of events) {
      if (e.type !== 'agent.tool_call') continue;
      const r = results.get(`${e.runId}/${e.payload.toolCallId}`);
      const data = r ? resultData(r.payload.result, r.payload.resultPreview) : undefined;
      const h = headline(e.payload.tool, e.payload.args, data, {
        minute: e.simMinute,
        failed: r && !r.payload.ok,
      });
      expect(h.length).toBeLessThanOrEqual(HEADLINE_MAX);
      check(h, e.payload.args, [e.payload.toolCallId]);
      checked++;
    }
    expect(checked).toBeGreaterThan(80);
  });

  it('follow the brief’s examples', () => {
    expect(
      headline('page_engineer', { station: 'MAN', engineerId: 'eng-1' }, { etaMinute: 13 }, { minute: 4 }),
    ).toBe('Paged an engineer at MAN — ETA 9 min');
    expect(
      headline(
        'find_spare_aircraft',
        { station: 'MAN' },
        { candidates: [{ tail: 'AX-LRM', feasible: true }] },
      ),
    ).toBe('Looked for a spare aircraft at MAN — found AX-LRM');
    expect(headline('find_spare_aircraft', { station: 'FAO' }, { candidates: [] })).toBe(
      'Looked for a spare aircraft at FAO — none available',
    );
    expect(headline('append_timeline', { text: 'Tow confirmed' })).toBe(
      'Logged to the incident record: Tow confirmed',
    );
    expect(headline('draft_passenger_message', { channel: 'sms' })).toBe('Drafted a passenger message (sms)');
    expect(headline('delegate', { role: 'maintenance' })).toBe('→ briefed Maintenance (MX)');
    expect(headline('delegate', { role: 'flightops' })).toBe('→ briefed Flight Operations');
    expect(headline('report', { openIssues: ['a', 'b'] })).toBe('Finished — 2 open issues');
    expect(headline('no_such_tool', {})).toBe('Used a tool');
    expect(headline('search_mel', { query: 'APU inoperative' })).toBe('Searched the MEL: APU inoperative');
  });

  it('clip free text with an ellipsis', () => {
    expect(clipText('short', 10)).toBe('short');
    const c = clipText(LONG, 30);
    expect(c.length).toBeLessThanOrEqual(30);
    expect(c.endsWith('…')).toBe(true);
    expect(headline('append_timeline', { text: LONG }).endsWith('…')).toBe(true);
  });
});
