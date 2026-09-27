/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Mock mode's Agents-view showcase (task 08): the s01 recording with the few row types a clean recording never
 * has, so every row type can be seen without a backend: the Scenario Author banner (`scenario.authoring`), a
 * report flagged by output screening (`guardrail.flagged` + `screeningFlags`), and a second Ground agent that is
 * stopped by the per-agent tool-call limit (`agent.aborted`). Fictional data; seqs are renumbered gap-free.
 */
import type { RunEvent } from '@ica/schema/browser';
import { RECORDINGS } from './recordings';

export const SHOWCASE_RUN_ID = 'run-demo-agents';

type Loose = Record<string, unknown>;

function remapSeqs(e: RunEvent, map: Map<number, number>): RunEvent {
  const fix = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(fix);
    if (!v || typeof v !== 'object') return v;
    const out: Loose = {};
    for (const [k, x] of Object.entries(v as Loose)) {
      if (k === 'contributingSeqs' && Array.isArray(x))
        out[k] = x.map((s) => map.get(s as number)).filter((s): s is number => typeof s === 'number');
      else if (k === 'causedBySeq' && typeof x === 'number') out[k] = map.get(x) ?? x;
      else out[k] = fix(x);
    }
    return out;
  };
  return { ...e, payload: fix(e.payload) } as RunEvent;
}

export function buildAgentsShowcase(source: RunEvent[] = RECORDINGS[0]!.agent): RunEvent[] {
  const first = source[0]!;
  const at = (minute: number) => ({
    runId: first.runId,
    simMinute: minute,
    simTime: new Date(Date.parse(first.simTime) - first.simMinute * 60_000 + minute * 60_000).toISOString(),
    wallTime: first.wallTime,
  });
  const world = { kind: 'world' as const };
  const orch = { kind: 'agent' as const, role: 'orchestrator' as const };
  const ground = { kind: 'agent' as const, role: 'ground' as const };
  const mx = { kind: 'agent' as const, role: 'maintenance' as const };
  const orchRun = source.find(
    (e) => e.type === 'agent.started' && e.payload.role === 'orchestrator',
  )?.agentRunId;

  const authoring = [
    {
      ...at(0),
      seq: 0,
      type: 'scenario.authoring',
      actor: world,
      payload: { status: 'started', detail: 'Preparing scenario from your description…' },
    },
    {
      ...at(0),
      seq: 0,
      type: 'scenario.authoring',
      actor: world,
      payload: { status: 'patched', detail: 'Scenario enriched from your description' },
    },
  ] as unknown as RunEvent[];

  const mxReport = source.find(
    (e): e is RunEvent<'agent.report'> => e.type === 'agent.report' && e.payload.role === 'maintenance',
  );
  const flagged = mxReport
    ? ([
        {
          ...at(mxReport.simMinute),
          seq: 0,
          type: 'guardrail.flagged',
          actor: mx,
          agentRunId: mxReport.agentRunId,
          parentAgentRunId: mxReport.parentAgentRunId,
          payload: {
            layer: 'output_screen',
            reason: 'The report states an airworthiness status in its own words',
            findings: [{ pattern: 'status:serviceable', excerpt: 'the aircraft looks serviceable' }],
          },
        },
      ] as unknown as RunEvent[])
    : [];

  // A second Ground agent, briefed late, stopped by the per-agent tool-call limit.
  const m = 45;
  const second = [
    {
      ...at(m),
      seq: 0,
      type: 'agent.tool_call',
      actor: orch,
      agentRunId: orchRun,
      iteration: 4,
      payload: {
        toolCallId: 'tc-showcase-delegate',
        tool: 'delegate',
        system: 'runtime',
        tier: 'execute',
        args: { role: 'ground', brief: 'Hold stand 34 for the swap and brief the handler on the new tail.' },
      },
    },
    {
      ...at(m),
      seq: 0,
      type: 'agent.started',
      actor: ground,
      agentRunId: 'ar-gnd-2',
      parentAgentRunId: orchRun,
      payload: {
        role: 'ground',
        brief: 'Hold stand 34 for the swap and brief the handler on the new tail.',
        parentAgentRunId: orchRun,
      },
    },
    {
      ...at(m + 0.2),
      seq: 0,
      type: 'agent.thought',
      actor: ground,
      agentRunId: 'ar-gnd-2',
      parentAgentRunId: orchRun,
      iteration: 0,
      payload: {
        text: 'Check stand 34 before telling the handler about AX-LRM.',
        summary: 'Check stand 34 first.',
      },
    },
    {
      ...at(m + 0.3),
      seq: 0,
      type: 'agent.tool_call',
      actor: ground,
      agentRunId: 'ar-gnd-2',
      parentAgentRunId: orchRun,
      iteration: 0,
      payload: {
        toolCallId: 'tc-showcase-stands',
        tool: 'get_stand_status',
        system: 'airport',
        tier: 'execute',
        args: { station: 'MAN' },
      },
    },
    {
      ...at(m + 0.4),
      seq: 0,
      type: 'agent.tool_result',
      actor: ground,
      agentRunId: 'ar-gnd-2',
      parentAgentRunId: orchRun,
      iteration: 0,
      payload: {
        toolCallId: 'tc-showcase-stands',
        tool: 'get_stand_status',
        ok: true,
        resultPreview: '{"station":"MAN","stands":3,"free":1}',
        result: {
          station: 'MAN',
          stands: [
            { id: '32', free: false },
            { id: '34', free: true },
            { id: 'R7', free: false },
          ],
        },
      },
    },
    {
      ...at(m + 1),
      seq: 0,
      type: 'agent.aborted',
      actor: ground,
      agentRunId: 'ar-gnd-2',
      parentAgentRunId: orchRun,
      payload: { role: 'ground', reason: 'tool_calls', detail: 'tool calls 60 ≥ 60 for this agent' },
    },
    {
      ...at(m + 1),
      seq: 0,
      type: 'agent.tool_result',
      actor: orch,
      agentRunId: orchRun,
      iteration: 4,
      payload: {
        toolCallId: 'tc-showcase-delegate',
        tool: 'delegate',
        ok: false,
        resultPreview: 'The Ground agent stopped: tool-call limit reached.',
      },
    },
  ] as unknown as RunEvent[];

  const out: RunEvent[] = [];
  let lateInserted = false;
  for (const e of source) {
    if (!lateInserted && e.simMinute > m) {
      out.push(...second);
      lateInserted = true;
    }
    if (mxReport && e === mxReport) {
      out.push(...flagged, {
        ...mxReport,
        payload: {
          ...mxReport.payload,
          report: {
            ...mxReport.payload.report,
            screeningFlags: [{ pattern: 'status:serviceable', excerpt: 'the aircraft looks serviceable' }],
          },
        },
      } as RunEvent);
      continue;
    }
    out.push(e);
    if (e.type === 'run.created') out.push(...authoring);
  }
  // Renumber gap-free, keeping causal and KPI references pointing at the same events.
  const map = new Map<number, number>();
  out.forEach((e, i) => {
    if (e.seq > 0) map.set(e.seq, i + 1);
  });
  return out.map((e, i) => remapSeqs({ ...e, seq: i + 1 } as RunEvent, map));
}
