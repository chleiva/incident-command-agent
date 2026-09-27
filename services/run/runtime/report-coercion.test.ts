/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * A report never blocks on its shape (demo review 2026-09-27: Ground's report was refused from m18 to m25 for
 * "invalid details"; live logs show `/openIssues: must be array` and `missing required: recommendations`).
 */
import { describe, expect, it } from 'vitest';
import type { JSONSchema } from '@ica/schema';
import { validateAgainst } from '../guardrails/validate';
import { roles } from '../agents/index';
import { call, scriptByAgent, step } from '../llm/scripted';
import { makeHarness, ofType } from './__fixtures__/harness';
import { coerceReportArgs, relaxReportSchema, splitListText } from './report';
import { defaultRegistry } from './registry';

const schemaOf = (role: keyof typeof roles) => relaxReportSchema(roles[role]!.reportSchema as JSONSchema);
const valid = (role: keyof typeof roles, args: Record<string, unknown>) =>
  validateAgainst(schemaOf(role), args).ok;

describe('coerceReportArgs (realistic malformed reports)', () => {
  it('orchestrator (live): openIssues as a string, recommendations missing, an unknown number field', () => {
    const raw = {
      summary: 'Incident under control: swap approved, passengers informed, engineer on site.',
      outcome: 'Swap',
      openIssues: '- Certifying engineer to sign the inspection\n- Crew FDP to recheck at 09:00',
      firstPaxMessageMinute: 12,
      citations: [],
    };
    expect(valid('orchestrator', raw)).toBe(false);
    const { args, repaired } = coerceReportArgs(raw, schemaOf('orchestrator'));
    expect(args.openIssues).toEqual([
      'Certifying engineer to sign the inspection',
      'Crew FDP to recheck at 09:00',
    ]);
    expect(args.recommendations).toEqual([]);
    expect(args.outcome).toBe('swap');
    expect(args.firstPaxMessageMinute).toBe(12); // unknown key untouched (goes to extras later)
    expect(repaired.sort()).toEqual(['openIssues', 'outcome', 'recommendations']);
    expect(valid('orchestrator', args)).toBe(true);
  });

  it('flightops (live): openIssues missing; options with one malformed entry; crewAtRisk as text', () => {
    const raw = {
      summary: 'Two options: wait for the repair or swap to the MAN spare; crew legal for both.',
      recommendations: ['Swap to AX-MAS'],
      citations: [],
      crewAtRisk: 'crew-211-cc1, crew-211-cc2',
      options: [{ label: 'no id' }],
    };
    const { args, repaired } = coerceReportArgs(raw, schemaOf('flightops'));
    expect(args.openIssues).toEqual([]);
    expect(args.crewAtRisk).toEqual(['crew-211-cc1, crew-211-cc2']);
    expect(args.options).toEqual([]); // the one invalid option dropped, the report kept
    expect(repaired).toContain('openIssues');
    expect(valid('flightops', args)).toBe(true);
  });

  it('ground: standPlan as a list, pendingRequests as bullets, recommendations as an object', () => {
    const raw = {
      summary: 'Aircraft stays on stand 12; tow booked for 07:40 and two buses on standby.',
      actionsTaken: 'Requested tow; requested 2 buses',
      openIssues: [],
      recommendations: { first: 'Keep passengers on board', then: 'Deplane by bus if delay > 60 min' },
      citations: ['IGOM 4.1'],
      standPlan: ['Stay on stand 12', 'Remote stand R5 held as backup'],
      pendingRequests: '• REQ-001 tow\n• REQ-002 buses',
    };
    const { args } = coerceReportArgs(raw, schemaOf('ground'));
    expect(args.standPlan).toBe('Stay on stand 12; Remote stand R5 held as backup');
    expect(args.pendingRequests).toEqual(['REQ-001 tow', 'REQ-002 buses']);
    expect(args.actionsTaken).toEqual(['Requested tow', 'requested 2 buses']);
    expect(args.recommendations).toEqual([
      'first: Keep passengers on board; then: Deplane by bus if delay > 60 min',
    ]);
    expect(args.citations).toEqual([]); // a bare string is not a citation: dropped, not blocking
    expect(valid('ground', args)).toBe(true);
  });

  it('maintenance: numbers from strings, provisionalReading from text, an unfixable field set aside', () => {
    const raw = {
      summary: 'Engineer paged (ETA m34); inspection needed before any release by certifying staff.',
      openIssues: [],
      recommendations: [],
      citations: [],
      engineerEtaMinute: 'm34',
      estimatedServiceableMinute: 'unknown',
      provisionalReading: 'Possible torque-link damage; needs NDT',
      decisionNeededFrom: { who: 'Certifying engineer' },
    };
    const { args } = coerceReportArgs(raw, schemaOf('maintenance'));
    expect(args.engineerEtaMinute).toBe(34);
    expect(args.estimatedServiceableMinute).toBeNull();
    expect(args.provisionalReading).toEqual({
      text: 'Possible torque-link damage; needs NDT',
      unconfirmed: true,
    });
    expect(args.decisionNeededFrom).toBe('who: Certifying engineer');
    expect(valid('maintenance', args)).toBe(true);
  });

  it('summary is only turned into text; a missing summary is still missing', () => {
    const { args } = coerceReportArgs({ summary: ['Done the checks', 'All good'] }, schemaOf('ground'));
    expect(args.summary).toBe('Done the checks; All good');
    const none = coerceReportArgs({ openIssues: 'x' }, schemaOf('ground'));
    expect(none.args.summary).toBeUndefined();
    expect(valid('ground', none.args)).toBe(false);
  });

  it('splitListText handles numbering, bullets and "; "', () => {
    expect(splitListText('1. a\n2) b\n\n- c')).toEqual(['a', 'b', 'c']);
    expect(splitListText('only one')).toEqual(['only one']);
    expect(splitListText('a; b; c')).toEqual(['a', 'b', 'c']);
  });
});

describe('report through the loop', () => {
  it('a malformed report is accepted on the first attempt, with the coercions recorded as argsRepaired', async () => {
    const ground = {
      summary: 'Aircraft stays on stand; tow and buses requested, handler informed of the hold.',
      openIssues: 'Tow slot not confirmed yet',
      citations: [],
      standPlan: ['Stay on stand', 'R5 backup'],
    };
    const h = await makeHarness({
      registry: defaultRegistry(),
      script: scriptByAgent({
        orchestrator: [
          step('Delegating.', call('delegate', { role: 'ground', brief: 'Plan the stand.' })),
          step(
            'Done.',
            call('report', {
              summary: 'Ground plan in place; nothing further outstanding.',
              openIssues: [],
              recommendations: [],
              citations: [],
            }),
          ),
        ],
        ground: [step('Reporting.', call('report', ground, 'tu_rep'))],
      }),
    });
    const result = await h.run();
    expect(result.status).toBe('completed');
    const events = await h.events();
    expect(ofType(events, 'guardrail.blocked').filter((e) => e.payload.tool === 'report')).toHaveLength(0);
    const tc = ofType(events, 'agent.tool_call').find((e) => e.payload.toolCallId === 'tu_rep');
    expect(tc?.payload.argsRepaired).toEqual(
      expect.arrayContaining(['openIssues', 'recommendations', 'standPlan']),
    );
    const rep = ofType(events, 'agent.report').find((e) => e.payload.role === 'ground');
    expect(rep?.payload.report).toMatchObject({
      openIssues: ['Tow slot not confirmed yet'],
      standPlan: 'Stay on stand; R5 backup',
    });
    expect(rep?.payload.report.composedByRuntime).toBeUndefined();
  });
});
