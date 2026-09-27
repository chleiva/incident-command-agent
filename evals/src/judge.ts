/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Layer 4: the rubric judge (spec §10). A stronger model than the agents (`EVAL_JUDGE_MODEL`, default
 * claude-opus-5-5) grades a COMPACT RUN DIGEST (≈6–10k tokens, never the raw trace), twice, and the two judgements
 * are averaged. Verdicts are recorded as fixtures so the replay tier re-uses them at £0.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentReport, LlmProvider, LlmUsage, RunEvent, RunProjection } from '@ica/schema';
import { costUsd, wrapDocument } from '@ica/run';
import { JUDGE_MAX_OUTPUT_TOKENS, JUDGEMENTS_PER_CASE } from './budget';
import type { OutcomeDelta } from './assertions';

export const DIMENSIONS = [
  'understanding',
  'alternatives',
  'passengerMessage',
  'occurrenceReport',
  'humanAuthority',
  'faithfulness',
] as const;
export type Dimension = (typeof DIMENSIONS)[number];
export type Judgement = Record<Dimension, { score: number | null; why: string }>;

export const DEFAULT_JUDGE_MODEL = 'claude-opus-5-5';
export const DIGEST_MAX_CHARS = 32_000;

export interface Rubric {
  version: string;
  text: string;
}

/** Load the versioned rubric prompts (evals/rubrics/*.md, in file order). The text is a constant system prompt. */
export function loadRubric(dir: string): Rubric {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort();
  const text = files.map((f) => readFileSync(join(dir, f), 'utf8').trim()).join('\n\n');
  const declared = /rubric-version:\s*(\S+)/.exec(text)?.[1] ?? '0';
  const hash = createHash('sha256').update(text).digest('hex').slice(0, 8);
  return { version: `${declared}-${hash}`, text };
}

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

export interface DigestInput {
  caseId: string;
  scenario: { title: string; narrative: string; trigger: string; station: string };
  referenceSummary: string;
  events: RunEvent[];
  projection: RunProjection;
  outcome?: OutcomeDelta;
}

/** A compact, deterministic digest of a run for the judge (≤ DIGEST_MAX_CHARS). */
export function buildDigest(d: DigestInput): string {
  const lines: string[] = [];
  const push = (s: string) => lines.push(s);
  push(`# Case ${d.caseId}: ${d.scenario.title} (${d.scenario.station})`);
  push(`Trigger: ${clip(d.scenario.trigger, 400)}`);
  push(`Narrative: ${clip(d.scenario.narrative, 1500)}`);
  push(`Reference summary: ${clip(d.referenceSummary || '(none)', 800)}`);

  push('\n## Agent reports');
  for (const e of d.events) {
    if (e.type !== 'agent.report') continue;
    const r = e.payload.report as AgentReport;
    push(`- ${e.payload.role} @m${e.simMinute.toFixed(0)}: ${clip(r.summary, 600)}`);
    if (r.actionsTaken.length) push(`  actions: ${clip(r.actionsTaken.join('; '), 500)}`);
    if (r.openIssues.length) push(`  open issues: ${clip(r.openIssues.join('; '), 400)}`);
    if (r.recommendations.length) push(`  recommendations: ${clip(r.recommendations.join('; '), 400)}`);
    for (const c of r.citations.slice(0, 5)) push(`  cites ${c.sourceId}: "${clip(c.quote, 200)}"`);
  }
  for (const e of d.events) {
    if (e.type === 'agent.aborted')
      push(`- ${e.payload.role} STOPPED (${e.payload.reason}): ${clip(e.payload.detail, 200)}`);
  }

  push('\n## Proposals and decisions');
  const decisions = new Map<string, RunEvent>();
  for (const e of d.events) if (e.type === 'approval.decision') decisions.set(e.payload.approvalId, e);
  for (const e of d.events) {
    if (e.type !== 'agent.proposal') continue;
    const dec = decisions.get(e.payload.approvalId);
    const decText =
      dec && dec.type === 'approval.decision'
        ? `${dec.payload.decision} by ${dec.payload.decidedBy.kind === 'human' ? dec.payload.decidedBy.roleTitle : dec.payload.decidedBy.kind}${dec.payload.selectedOptionId ? ` (option ${dec.payload.selectedOptionId})` : ''}${dec.payload.reason ? `: ${clip(dec.payload.reason, 120)}` : ''}`
        : 'undecided';
    push(`- @m${e.simMinute.toFixed(0)} ${e.payload.tool}: ${clip(e.payload.summary, 250)} → ${decText}`);
    for (const o of e.payload.options ?? []) {
      push(
        `  option ${o.id}${o.recommended ? ' (recommended)' : ''}: ${o.label}; ${o.metrics.timeToDepartureMin} min, €${o.metrics.costEur}, impact ${o.metrics.customerImpact}, compliant ${o.metrics.compliant}${o.metrics.constraints.length ? `, ${clip(o.metrics.constraints.join('; '), 150)}` : ''}`,
      );
    }
  }

  const sys = d.projection.systems;
  push('\n## Passenger messages');
  for (const m of Object.values(sys.pss?.messages ?? {})) {
    push(
      `- [${m.status}${m.sentAtMinute !== undefined ? ` @m${m.sentAtMinute.toFixed(0)}` : ''}] (${m.channel}, ${m.cohortIds.join(',')}): ${clip(m.body, 700)}`,
    );
  }
  push('\n## Report drafts and techlog');
  for (const r of Object.values(sys.record?.reports ?? {}))
    push(`- ${r.kind} report draft: ${clip(r.body, 1500)}`);
  for (const t of Object.values(sys.mne?.techlog ?? {}))
    push(`- techlog [${t.status}]: ${clip(t.text, 500)}`);
  for (const dcs of Object.values(sys.mne?.decisions ?? {})) {
    const who = dcs.decidedBy.kind === 'human' ? dcs.decidedBy.roleTitle : dcs.decidedBy.kind;
    push(
      `- engineering decision ${dcs.decision} by ${who} @m${dcs.atMinute.toFixed(0)}: ${clip(dcs.rationale, 200)}`,
    );
  }

  push('\n## Guardrail blocks');
  for (const e of d.events) {
    if (e.type === 'guardrail.blocked')
      push(
        `- ${e.payload.layer}${e.payload.tool ? ` ${e.payload.tool}` : ''}: ${clip(e.payload.reason, 200)}`,
      );
  }

  push('\n## Knowledge retrieved (citations returned by tools)');
  const seen = new Set<string>();
  for (const e of d.events) {
    if (e.type !== 'agent.tool_result') continue;
    for (const c of e.payload.citations ?? []) {
      if (seen.has(c.chunkId)) continue;
      seen.add(c.chunkId);
      push(`- ${c.sourceId} [${c.chunkId}]: "${clip(c.quote, 250)}"`);
    }
  }

  push('\n## Outcome vs scripted human baseline');
  if (d.outcome?.agent) {
    push(`agent: ${JSON.stringify(d.outcome.agent)}`);
    push(`baseline: ${JSON.stringify(d.outcome.baseline)}`);
  } else if (d.projection.kpis) {
    const k = d.projection.kpis;
    push(
      `agent: total €${k.totalCostEur.value}, satisfaction ${k.satisfaction.value}, compliance ${JSON.stringify(k.compliance.value)}`,
    );
  }
  return clip(lines.join('\n'), DIGEST_MAX_CHARS);
}

export function parseJudgement(text: string): Judgement {
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) throw new Error('judge returned no JSON');
  const raw = JSON.parse(m[0]) as Record<string, { score?: unknown; why?: unknown } | undefined>;
  const out = {} as Judgement;
  for (const d of DIMENSIONS) {
    const s = raw[d]?.score;
    const score = typeof s === 'number' && s >= 1 && s <= 5 ? s : null;
    out[d] = { score, why: String(raw[d]?.why ?? '').slice(0, 400) };
  }
  return out;
}

export interface JudgeResult {
  caseId: string;
  judgeModel: string;
  rubricVersion: string;
  digestSha: string;
  createdAt: string;
  synthetic?: boolean;
  judgements: Judgement[];
  perDimension: Partial<Record<Dimension, number | null>>;
  mean: number | null;
  usd: number;
}

/** Average the judgements per dimension (ignoring nulls), then the mean over dimensions. */
export function aggregate(judgements: Judgement[]): {
  perDimension: JudgeResult['perDimension'];
  mean: number | null;
} {
  const perDimension: JudgeResult['perDimension'] = {};
  const means: number[] = [];
  for (const d of DIMENSIONS) {
    const xs = judgements.map((j) => j[d].score).filter((x): x is number => x !== null);
    const v = xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : null;
    perDimension[d] = v;
    if (v !== null) means.push(v);
  }
  return {
    perDimension,
    mean: means.length ? Math.round((means.reduce((a, b) => a + b, 0) / means.length) * 100) / 100 : null,
  };
}

/** Run the judge (two judgements, averaged). */
export async function judge(opts: {
  caseId: string;
  digest: string;
  rubric: Rubric;
  provider: LlmProvider;
  model: string;
  synthetic?: boolean;
}): Promise<JudgeResult> {
  const judgements: Judgement[] = [];
  let usd = 0;
  for (let i = 0; i < JUDGEMENTS_PER_CASE; i++) {
    const res = await opts.provider.complete({
      model: opts.model,
      system: opts.rubric.text,
      messages: [
        { role: 'user', content: [{ type: 'text', text: wrapDocument('run-digest', opts.digest) }] },
      ],
      tools: [],
      maxTokens: JUDGE_MAX_OUTPUT_TOKENS,
      temperature: 0,
      cacheHints: { system: true },
      meta: {
        runId: `judge-${opts.caseId}`,
        agentRunId: `judge-${i + 1}`,
        role: 'orchestrator',
        iteration: i,
        agentPath: `judge/${i + 1}`,
      },
    });
    usd += costUsd(opts.model, res.usage as LlmUsage);
    judgements.push(parseJudgement(res.text));
  }
  const { perDimension, mean } = aggregate(judgements);
  return {
    caseId: opts.caseId,
    judgeModel: opts.model,
    rubricVersion: opts.rubric.version,
    digestSha: createHash('sha256').update(opts.digest).digest('hex').slice(0, 16),
    createdAt: new Date().toISOString(),
    ...(opts.synthetic ? { synthetic: true } : {}),
    judgements,
    perDimension,
    mean,
    usd: Math.round(usd * 1e6) / 1e6,
  };
}
