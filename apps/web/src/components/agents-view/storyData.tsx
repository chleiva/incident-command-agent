/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** Storybook data for the Agents view (task 08): the mock-mode showcase and the s01/s04 recordings. */
import { foldEvents, type RunEvent } from '@ica/schema/browser';
import { useState } from 'react';
import { columnStatus, deriveAgents, turnCount, type AgentRow, type RowKind } from '../../agents/rows';
import { buildAgentsShowcase } from '../../mocks/agentsShowcase';
import { RECORDINGS } from '../../mocks/recordings';
import type { AgentsBoardProps } from './AgentsBoard';
import { AgentRowView } from './AgentRowView';
import { factsFor, reasoningFor } from '../../agents/rows';
import { decidedText } from './AgentsBoard';
import { RowDetail } from './RowDetail';

export const SHOWCASE_EVENTS = buildAgentsShowcase();
export const S04_EVENTS = RECORDINGS[1]!.agent;

export function boardArgs(events: RunEvent[], extra: Partial<AgentsBoardProps> = {}): AgentsBoardProps {
  const model = deriveAgents(events);
  const view = foldEvents(events);
  return {
    model,
    statusByRole: Object.fromEntries(model.columns.map((c) => [c.role, columnStatus(view, c.role)])),
    turnsByRole: Object.fromEntries(model.columns.map((c) => [c.role, turnCount(c.rows)])),
    cursorSeq: null,
    hideThoughts: false,
    live: false,
    ...extra,
  };
}

/** Events up to (and including) the first proposal of an approval: a live waiting row. */
export function untilProposal(events: RunEvent[], approvalId: string): RunEvent[] {
  return events.slice(
    0,
    events.findIndex((e) => e.type === 'agent.proposal' && e.payload.approvalId === approvalId) + 1,
  );
}

export const SHOWCASE_MODEL = deriveAgents(SHOWCASE_EVENTS);
const S04_MODEL = deriveAgents(S04_EVENTS);
const PENDING_MODEL = deriveAgents(untilProposal(RECORDINGS[0]!.agent, 'ap-msg-1'));

/**
 * The showcase, cut at its first pending proposal, then continued in a fresh worker (15-min compute limit): the
 * orchestrator's hand-over stop, `run.continuing` and `run.continued` (additive events), seqs gap-free.
 */
export const CONTINUED_EVENTS: RunEvent[] = (() => {
  const base = untilProposal(RECORDINGS[0]!.agent, 'ap-msg-1');
  const last = base.at(-1)!;
  const orch = base.find((e) => e.type === 'agent.started')!;
  const tail = (n: number, type: string, payload: object, extra: object = {}) =>
    ({
      ...last,
      seq: last.seq + n,
      type,
      actor: { kind: 'world' },
      agentRunId: undefined,
      parentAgentRunId: undefined,
      iteration: undefined,
      payload,
      ...extra,
    }) as unknown as RunEvent;
  return [
    ...base,
    tail(
      1,
      'agent.aborted',
      { role: 'orchestrator', reason: 'stopped', detail: 'run signal aborted' },
      { agentRunId: orch.agentRunId, actor: { kind: 'agent', role: 'orchestrator' } },
    ),
    tail(2, 'run.continuing', { attempt: 1, maxAttempts: 12 }),
    tail(3, 'run.continued', { attempt: 1, atSimMinute: last.simMinute, pendingApprovals: 1 }),
  ];
})();
const CONTINUED_MODEL = deriveAgents(CONTINUED_EVENTS);

/** A representative row of each type. */
export function sampleRow(kind: RowKind, handover = false): { row: AgentRow; model: typeof SHOWCASE_MODEL } {
  const pick = (m: typeof SHOWCASE_MODEL, pred: (r: AgentRow) => boolean) => {
    const row = m.columns.flatMap((c) => c.rows).find(pred);
    return row ? { row, model: m } : null;
  };
  const found =
    kind === 'continuation' || handover
      ? pick(CONTINUED_MODEL, (r) => r.kind === kind && (kind !== 'stopped' || !!r.handover))
      : kind === 'waiting'
        ? pick(PENDING_MODEL, (r) => r.kind === 'waiting')
        : kind === 'invalidated'
          ? pick(S04_MODEL, (r) => r.kind === 'invalidated')
          : kind === 'decision'
            ? pick(S04_MODEL, (r) => r.kind === 'decision' && r.decision?.decision === 'reject')
            : kind === 'report'
              ? pick(SHOWCASE_MODEL, (r) => r.kind === 'report' && r.role === 'maintenance')
              : kind === 'tool'
                ? pick(SHOWCASE_MODEL, (r) => r.kind === 'tool' && r.role === 'maintenance' && r.turn === 3)
                : pick(SHOWCASE_MODEL, (r) => r.kind === kind && !!(kind !== 'brief' || r.link));
  if (!found) throw new Error(`no sample row of kind ${kind}`);
  return found;
}

/** One row in a column-width frame, toggling like it does in a column. */
export function RowStory({
  kind,
  expanded: initial = false,
  handover = false,
}: {
  kind: RowKind;
  expanded?: boolean;
  /** Stop rows: the calm hand-over to a fresh worker. */
  handover?: boolean;
}) {
  const { row, model } = sampleRow(kind, handover);
  const [expanded, setExpanded] = useState(initial);
  const detailId = `story-${row.key}`;
  return (
    <div style={{ width: 300 }} className="rounded-lg border border-border bg-surface p-2">
      <ol aria-label="Sample row">
        <li>
          <AgentRowView
            row={row}
            expanded={expanded}
            focused
            detailId={detailId}
            onToggle={() => setExpanded(!expanded)}
            onFocus={() => {}}
            onKeyDown={() => {}}
            onFollowLink={row.link ? () => {} : undefined}
            decisionHref="#decisions"
          >
            <RowDetail
              id={detailId}
              row={row}
              facts={factsFor(model, row)}
              reasoning={reasoningFor(model, row)}
              decided={decidedText(row)}
            />
          </AgentRowView>
        </li>
      </ol>
    </div>
  );
}
