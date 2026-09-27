/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Eval case schema (TypeBox → `evals/case.schema.json`). Cases reference scenario ids from CLAUDE.md and keep their
 * overrides generic (patches and injections), so they can be written before the domain content lands.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Type, type Static } from '@sinclair/typebox';
import {
  GUARDRAIL_LAYERS,
  KNOWLEDGE_COLLECTIONS,
  OrderedPairSchema,
  compileSchema,
  literalUnion,
} from '@ica/schema';

const strict = { additionalProperties: false } as const;
const Str = Type.String({ minLength: 1 });

export const CASE_TIERS = ['smoke', 'core', 'full'] as const;

export const SeedPatchSchema = Type.Object(
  {
    system: Str,
    entity: Str,
    /** Entity id to patch; `*` = every entity of the map; omit with `record` to create. */
    id: Type.Optional(Str),
    patch: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    record: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  strict,
);

export const KnowledgeInjectionSchema = Type.Object(
  {
    collection: literalUnion(KNOWLEDGE_COLLECTIONS),
    sourceId: Str,
    title: Str,
    url: Type.String(),
    text: Str,
  },
  strict,
);

export const EvalCaseSchema = Type.Object(
  {
    $schema: Type.Optional(Type.String()),
    id: Type.String({ pattern: '^[a-z0-9-]{3,80}$' }),
    scenarioId: Type.String({ pattern: '^[a-z0-9-]{3,64}$' }),
    title: Str,
    /** `agent` (default) runs executeRun; `author` runs runAuthor on `authorText`. */
    kind: Type.Optional(Type.Union([Type.Literal('agent'), Type.Literal('author')])),
    tier: Type.Array(literalUnion(CASE_TIERS)),
    /** Lower = more important (live truncation keeps the highest priority first). */
    priority: Type.Integer({ minimum: 1, maximum: 100 }),
    adversarial: Type.Optional(Type.Boolean()),
    authorText: Type.Optional(Type.String({ maxLength: 8000 })),
    overrides: Type.Optional(
      Type.Object(
        {
          /** RFC 7386 JSON merge patch applied to the scenario. */
          scenarioPatch: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
          mockData: Type.Optional(Type.Array(SeedPatchSchema)),
          knowledgeInjection: Type.Optional(Type.Array(KnowledgeInjectionSchema)),
          /** Generic, content-independent scenario transforms (variants). */
          transforms: Type.Optional(
            Type.Object(
              {
                twistShiftMin: Type.Optional(Type.Number()),
                crewFdpMarginDeltaMin: Type.Optional(Type.Number()),
                engineerDelayMin: Type.Optional(Type.Number()),
                spareDelayMin: Type.Optional(Type.Number()),
                noSpares: Type.Optional(Type.Boolean()),
                narrativeAppend: Type.Optional(Type.String({ maxLength: 2000 })),
              },
              strict,
            ),
          ),
        },
        strict,
      ),
    ),
    policy: Type.Object({ rejectTools: Type.Optional(Type.Array(Str)) }, strict),
    expected: Type.Object(
      {
        /** Merge the scenario's own `expected` (tools, pairs, latency targets, summary) at run time. */
        inheritScenarioExpected: Type.Optional(Type.Boolean()),
        hardConstraints: Type.Object(
          {
            noSoftwareDeferral: Type.Boolean(),
            noFdpExtension: Type.Boolean(),
            noForbiddenExecuted: Type.Boolean(),
            allProposalsDecided: Type.Boolean(),
            noLegalClaimsSent: Type.Boolean(),
          },
          strict,
        ),
        requiredTools: Type.Array(Str),
        forbiddenTools: Type.Array(Str),
        orderedPairs: Type.Array(OrderedPairSchema),
        latencyTargets: Type.Object(
          {
            firstPaxMessageBeforeMin: Type.Optional(Type.Number({ minimum: 0 })),
            engineerPagedBeforeMin: Type.Optional(Type.Number({ minimum: 0 })),
            decisionBeforeMin: Type.Optional(Type.Number({ minimum: 0 })),
          },
          strict,
        ),
        /** Adversarial expectations: markers that would show the injection was followed, and required blocks. */
        robustness: Type.Optional(
          Type.Object(
            {
              injectedTools: Type.Array(Str),
              canary: Type.Optional(Str),
              expectBlockedLayers: Type.Array(literalUnion(GUARDRAIL_LAYERS)),
              expectAuthorRejected: Type.Optional(Type.Boolean()),
            },
            strict,
          ),
        ),
        referenceSummary: Type.String(),
      },
      strict,
    ),
  },
  strict,
);
export type EvalCase = Static<typeof EvalCaseSchema>;

export const validateCase = compileSchema(EvalCaseSchema);

export function caseJsonSchema(): Record<string, unknown> {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'urn:incident-command-agent:schema:eval-case:1',
    title: 'Incident Coordination Agent eval case',
    ...(JSON.parse(JSON.stringify(EvalCaseSchema)) as Record<string, unknown>),
  };
}

export function loadCases(dir: string): EvalCase[] {
  const out: EvalCase[] = [];
  for (const f of readdirSync(dir)
    .filter((x) => x.endsWith('.json'))
    .sort()) {
    const raw = JSON.parse(readFileSync(join(dir, f), 'utf8')) as unknown;
    const v = validateCase(raw);
    if (!v.ok) throw new Error(`invalid case ${f}: ${v.errors.join('; ')}`);
    if (`${v.value.id}.json` !== f)
      throw new Error(`case file ${f} must be named after its id ${v.value.id}`);
    out.push(v.value);
  }
  return out.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
}
