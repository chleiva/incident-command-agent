/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import { AGENT_ROLES, compileSchema } from '@ica/schema';
import { domainTools } from '../tools/index';
import { roles } from './index';

describe('agent roles', () => {
  it('defines all seven roles with constant prompts and report schemas', () => {
    expect(Object.keys(roles).sort()).toEqual([...AGENT_ROLES].sort());
    for (const r of AGENT_ROLES) {
      const def = roles[r];
      expect(def.role).toBe(r);
      expect(def.stop).toBe('report_tool');
      expect(def.systemPrompt.length).toBeGreaterThan(400);
      // tight: stays well under ~1,000 tokens
      expect(def.systemPrompt.length).toBeLessThan(4500);
      // no template placeholders or interpolation markers
      expect(def.systemPrompt).not.toMatch(/\$\{|\{\{|undefined|\[object Object\]/);
    }
  });

  it("each role's tools are exactly the domain tools that list it (orchestrator uses runtime tools only)", () => {
    for (const r of AGENT_ROLES) {
      const expected = domainTools
        .filter((t) => t.roles.includes(r))
        .map((t) => t.name)
        .sort();
      expect([...roles[r].tools].sort(), r).toEqual(expected);
    }
    expect(roles.orchestrator.tools).toEqual([]);
  });

  it('report schemas extend AgentReport and validate a minimal report', () => {
    const minimal = { summary: 'ok', actionsTaken: [], openIssues: [], recommendations: [], citations: [] };
    for (const r of AGENT_ROLES) {
      const v = compileSchema(roles[r].reportSchema as never);
      expect(v(minimal).ok, r).toBe(true);
      expect(v({ ...minimal, summary: undefined }).ok, r).toBe(false);
    }
    const fo = compileSchema(roles.flightops.reportSchema as never);
    expect(
      fo({
        ...minimal,
        options: [
          {
            id: 'swap',
            label: 'Swap to NW-FXB',
            metrics: {
              timeToDepartureMin: 80,
              costEur: 7200,
              customerImpact: 30,
              compliant: true,
              constraints: [],
            },
            recommended: true,
          },
        ],
      }).ok,
    ).toBe(true);
  });

  it('prompts carry the authority boundary and the passenger tone rules', () => {
    for (const r of ['orchestrator', 'maintenance', 'ground', 'flightops', 'passenger', 'record'] as const)
      expect(roles[r].systemPrompt).toMatch(/certifying staff only/);
    expect(roles.passenger.systemPrompt).toMatch(/Never claim "extraordinary circumstances"/);
    expect(roles.orchestrator.systemPrompt).toMatch(/within 15 sim minutes/);
    expect(roles.orchestrator.systemPrompt).toMatch(/request_decision/);
    expect(roles.author.systemPrompt).toMatch(/validate_scenario/);
  });
});
