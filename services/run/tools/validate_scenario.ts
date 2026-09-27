/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import { getStation } from '@ica/kb';
import { SCENARIO_IDS, validateScenario, type ToolDefinition } from '@ica/schema';
import { obj, ok } from './_shared';

export const validate_scenario: ToolDefinition<{ scenario: Record<string, unknown> }> = {
  name: 'validate_scenario',
  description:
    'Validate a candidate scenario JSON against the schema (schemaVersion 1) plus domain checks: real IATA stations, fictional Accent Air data (ACX flight numbers, AX-XXX tails), unique ids, a fresh id. Returns ok, or the list of errors as JSON pointers to fix. Call it until it returns ok.',
  inputSchema: obj({ scenario: { type: 'object', description: 'The complete scenario object' } }, [
    'scenario',
  ]),
  tier: 'execute',
  system: 'knowledge',
  roles: ['author'],
  mutates: false,
  async handler({ scenario }, ctx) {
    const r = validateScenario(scenario);
    if (!r.ok) return ok({ valid: false, errors: r.errors.slice(0, 40) });
    const s = r.value;
    const errors: string[] = [];
    const stations = new Set<string>([s.aircraft.station]);
    for (const x of [...s.aircraft.nextSectors, ...s.world.rotation]) {
      stations.add(x.from);
      stations.add(x.to);
    }
    for (const x of [...s.world.spares, ...s.world.engineers, ...s.world.crew, ...s.world.stands])
      stations.add(x.station);
    for (const st of stations)
      if (!getStation(st)) errors.push(`unknown station ${st} (use a real IATA code; see lookup_airport)`);
    if ((SCENARIO_IDS as readonly string[]).includes(s.id))
      errors.push(`/id "${s.id}" is reserved for a shipped scenario`);
    // inspiredBy may only cite reports that exist in the precedent corpus (never invented ids).
    for (const [i, ref] of s.inspiredBy.entries()) {
      const hits = await ctx.knowledge.search({ query: ref.sourceId, collections: ['precedent'], k: 8 });
      if (!hits.some((h) => h.sourceId === ref.sourceId))
        errors.push(
          `/inspiredBy/${i}/sourceId "${ref.sourceId}" is not in the precedent corpus; cite only ids returned by search_precedents`,
        );
    }
    return ok(errors.length ? { valid: false, errors } : { valid: true, id: s.id, title: s.title });
  },
};
