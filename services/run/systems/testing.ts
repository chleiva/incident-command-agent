/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Light test harness for task 03: seed a scenario, build a `ToolContext`, call tool handlers directly and apply their
 * mutations, advance the world with `tickAll`. No agent loop, no network.
 */
import minimal from '@ica/schema/fixtures/scenario.minimal.json' with { type: 'json' };
import type {
  Actor,
  KnowledgeIndex,
  Scenario,
  SystemState,
  ToolContext,
  ToolDefinition,
  ToolOutcome,
} from '@ica/schema';
import { seededRng } from './names';
import { applyMutations, seedAll, tickAll } from './index';

export const fixtureScenario = (): Scenario => structuredClone(minimal) as unknown as Scenario;

export const CERTIFYING: Actor = {
  kind: 'human',
  name: 'Ada Pennick',
  roleTitle: 'Certifying Engineer (B1)',
};
export const DUTY_MANAGER: Actor = { kind: 'human', name: 'Sol Varden', roleTitle: 'Duty Manager' };

export const emptyKnowledge: KnowledgeIndex = { search: async () => [] };

export interface Harness {
  scenario: Scenario;
  state: SystemState;
  simMinute: number;
  rng: () => number;
  ctx(role?: ToolContext['role'], extra?: Partial<ToolContext>): ToolContext;
  /** Call a tool handler; on success apply its mutations to the harness state. */
  call<O = any>(tool: ToolDefinition, input: unknown, extra?: Partial<ToolContext>): Promise<ToolOutcome<O>>;
  /** Advance the world minute by minute (dt = 1) up to `minute`. */
  advanceTo(minute: number, dtMin?: number): void;
}

export function harness(
  scenario: Scenario = fixtureScenario(),
  knowledge: KnowledgeIndex = emptyKnowledge,
): Harness {
  const rng = seededRng(42);
  const h: Harness = {
    scenario,
    state: seedAll(scenario, rng),
    simMinute: 0,
    rng,
    ctx(role = 'maintenance', extra = {}) {
      return {
        runId: 'run-test',
        agentRunId: `agent-${role}`,
        role,
        actor: { kind: 'agent', role },
        simMinute: h.simMinute,
        state: h.state,
        scenario: h.scenario,
        knowledge,
        rng: h.rng,
        log: () => {},
        ...extra,
      };
    },
    async call(tool, input, extra = {}) {
      const role = extra.role ?? tool.roles[0];
      const out = await tool.handler(input, h.ctx(role, extra));
      if (out.ok && out.mutations?.length) h.state = applyMutations(h.state, out.mutations);
      return out;
    },
    advanceTo(minute, dtMin = 1) {
      while (h.simMinute < minute) {
        h.simMinute = Math.min(minute, h.simMinute + dtMin);
        const ms = tickAll(h.state, h.simMinute, dtMin);
        if (ms.length) h.state = applyMutations(h.state, ms);
      }
    },
  };
  return h;
}
