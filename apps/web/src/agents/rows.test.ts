/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** The Agents view model (task 08): rows, waiting/decision/invalidation/stop rows, delegation pairing, facts. */
import type { RunEvent } from '@ica/schema/browser';
import { foldEvents } from '@ica/schema/browser';
import { describe, expect, it } from 'vitest';
import { buildAgentsShowcase } from '../mocks/agentsShowcase';
import { RECORDINGS } from '../mocks/recordings';
import { HEADLINE_MAX } from './headline';
import {
  columnStatus,
  deriveAgents,
  factsFor,
  reasoningFor,
  stopHeadline,
  turnCount,
  type AgentRow,
} from './rows';

const [S01, S04, S11] = RECORDINGS as [
  (typeof RECORDINGS)[0],
  (typeof RECORDINGS)[0],
  (typeof RECORDINGS)[0],
];
const SHOWCASE = buildAgentsShowcase();

const rowsOf = (events: RunEvent[]) => deriveAgents(events).columns.flatMap((c) => c.rows);
const upToProposal = (events: RunEvent[], approvalId: string) =>
  events.slice(
    0,
    events.findIndex((e) => e.type === 'agent.proposal' && e.payload.approvalId === approvalId) + 1,
  );

describe('deriveAgents', () => {
  it('one column per agent role with actions (never the author), ordered by first activity, at most six', () => {
    for (const events of [S01.agent, S04.agent, S11.agent, SHOWCASE]) {
      const m = deriveAgents(events);
      expect(m.columns.length).toBeLessThanOrEqual(6);
      expect(m.columns.map((c) => c.role)).not.toContain('author');
      expect(m.columns[0]!.role).toBe('orchestrator');
      const firsts = m.columns.map((c) => c.firstSeq);
      expect([...firsts].sort((a, b) => a - b)).toEqual(firsts);
      for (const c of m.columns) {
        expect(c.rows.map((r) => r.seq)).toEqual([...c.rows.map((r) => r.seq)].sort((a, b) => a - b));
        for (const r of c.rows) expect(r.headline.length, r.headline).toBeLessThanOrEqual(HEADLINE_MAX);
      }
    }
  });

  it('tags rows with the turn (iteration + 1); parallel calls in one turn share it', () => {
    const orch = deriveAgents(S01.agent).columns[0]!;
    const delegates = orch.rows.filter((r) => r.call?.tool === 'delegate');
    const call = S01.agent.find(
      (e) => e.type === 'agent.tool_call' && e.payload.toolCallId === delegates[0]!.call!.toolCallId,
    )!;
    expect(delegates[0]!.turn).toBe(call.iteration! + 1);
    expect(new Set(delegates.slice(0, 4).map((r) => r.turn)).size).toBe(1);
    const thoughts = orch.rows.filter((r) => r.kind === 'thought');
    expect(thoughts.every((r) => r.headline === 'Reasoned about next steps')).toBe(true);
  });

  it('a proposal is followed by a live waiting row until the decision', () => {
    const pending = rowsOf(upToProposal(S01.agent, 'ap-msg-1'));
    const i = pending.findIndex((r) => r.kind === 'proposal' && r.approvalId === 'ap-msg-1');
    expect(i).toBeGreaterThanOrEqual(0);
    const waiting = pending[i + 1]!;
    expect(waiting.kind).toBe('waiting');
    expect(waiting.pending).toBe(true);
    expect(waiting.headline).toBe('Waiting for a decision: send a passenger message');
    expect(waiting.proposal?.approvalScope?.authorises).toMatch(/Sending this exact message/);

    const done = rowsOf(S01.agent).find((r) => r.kind === 'waiting' && r.approvalId === 'ap-msg-1')!;
    expect(done.pending).toBe(false);
  });

  it('human decisions are rows of their own: approved, approved with edits, rejected, policy', () => {
    const s01 = rowsOf(S01.agent).filter((r) => r.kind === 'decision');
    const approved = s01.find((r) => r.approvalId === 'ap-msg-1')!;
    expect(approved.headline).toBe('Approved by Duty Manager at m6');
    expect(approved.role).toBe('passenger');
    expect(s01.find((r) => r.approvalId === 'ap-msg-2')!.headline).toMatch(
      /^Approved with edits by Duty Manager at m\d+$/,
    );
    expect(s01.find((r) => r.approvalId === 'ap-eng-1')!.headline).toMatch(
      /^Approved by Certifying Engineer \(B1\) at m\d+$/,
    );
    const rejected = rowsOf(S04.agent).find(
      (r) => r.kind === 'decision' && r.decision?.decision === 'reject',
    )!;
    expect(rejected.headline).toMatch(/^Rejected by Duty Manager — .+/);
    expect(rejected.headline.length).toBeLessThanOrEqual(HEADLINE_MAX);
    const policy = rowsOf(S11.agent).find((r) => r.kind === 'decision')!;
    expect(policy.headline).toMatch(/^Approved by the eval auto-approver at m\d+$/);
  });

  it('an approval withdrawn by a changed assumption is a row', () => {
    const inv = rowsOf(S04.agent).find((r) => r.kind === 'invalidated')!;
    expect(inv.headline).toBe('Approval withdrawn: engineer ETA changed (m38 → m78)');
    expect(inv.role).toBe('passenger');
  });

  it('a terminal stop is a row with plain words; a refused call is a Blocked row', () => {
    const rows = rowsOf(SHOWCASE);
    const stop = rows.find((r) => r.kind === 'stopped')!;
    expect(stop.headline).toBe('Stopped: reached the 60 tool-call limit for this agent');
    expect(stop.role).toBe('ground');
    const blocked = rowsOf(S01.agent).find((r) => r.kind === 'blocked')!;
    expect(blocked.tier).toBe('blocked');
    expect(blocked.headline).toBe('Tried to defer a defect under the MEL');
    expect(stopHeadline({ role: 'ground', reason: 'iterations', detail: '' })).toBe(
      'Stopped: 25 steps without finishing',
    );
    expect(stopHeadline({ role: 'ground', reason: 'wall_clock', detail: '' })).toBe(
      'Stopped: run time limit',
    );
    expect(
      stopHeadline({ role: 'ground', reason: 'error', detail: 'provider timeout after 3 retries' }),
    ).toBe('Stopped: system error — provider timeout after 3 retries');
    expect(
      stopHeadline({ role: 'ground', reason: 'tool_calls', detail: '' }, { maxToolCallsPerAgent: 40 }),
    ).toBe('Stopped: reached the 40 tool-call limit for this agent');
  });

  it('refused calls do not change the column status; a stop makes it blocked', () => {
    const view = foldEvents(S01.agent);
    expect(columnStatus(view, 'maintenance')).toBe('done');
    expect(columnStatus(foldEvents(SHOWCASE), 'ground')).toBe('blocked');
    expect(columnStatus(foldEvents(upToProposal(S01.agent, 'ap-msg-1')), 'passenger')).toBe('waiting');
    const early = S01.agent.filter((e) => e.simMinute <= 4);
    expect(columnStatus(foldEvents(early), 'maintenance')).toBe('working');
  });

  it('pairs delegations both ways (→ briefed X ↔ ← brief from Orchestrator)', () => {
    const m = deriveAgents(S01.agent);
    const delegates = m.columns[0]!.rows.filter((r) => r.call?.tool === 'delegate');
    expect(delegates).toHaveLength(5);
    for (const d of delegates) {
      const brief = m.rowByKey.get(d.link!.targetKey)!;
      expect(brief.kind).toBe('brief');
      expect(brief.headline).toBe('← brief from Orchestrator');
      expect(brief.role).toBe((d.call!.args as { role: string }).role);
      expect(brief.link!.targetKey).toBe(d.key);
    }
    // The showcase's late second Ground agent pairs with the second delegate call to ground.
    const s = deriveAgents(SHOWCASE);
    const grounds = s.columns.find((c) => c.role === 'ground')!.rows.filter((r) => r.kind === 'brief');
    expect(grounds).toHaveLength(2);
    expect(grounds.every((b) => b.link)).toBe(true);
    expect(new Set(grounds.map((b) => b.link!.targetKey)).size).toBe(2);
  });

  it('shows the Scenario Author as a banner only when authoring happened', () => {
    expect(deriveAgents(S01.agent).author).toBeNull();
    const author = deriveAgents(SHOWCASE).author!;
    expect(author.line).toBe('Scenario enriched from your description');
    expect(author.steps.map((s) => s.status)).toEqual(['started', 'patched']);
  });

  it('attaches screening flags to the flagged report', () => {
    const report = rowsOf(SHOWCASE).find((r) => r.kind === 'report' && r.role === 'maintenance')!;
    expect(report.flags?.length).toBe(1);
    expect(report.report?.screeningFlags?.[0]?.pattern).toBe('status:serviceable');
  });

  it('facts gathered by a turn: the brief, earlier results, decisions so far and received reports', () => {
    const m = deriveAgents(S01.agent);
    const mx = m.columns.find((c) => c.role === 'maintenance')!;
    const t3 = mx.rows.find((r: AgentRow) => r.turn === 3 && r.kind === 'tool')!;
    const facts = factsFor(m, t3);
    expect(facts[0]!.kind).toBe('brief');
    const results = facts.filter((f) => f.kind === 'result');
    expect(results.length).toBeGreaterThan(0);
    // Only calls from earlier turns.
    const earlier = mx.rows.filter((r) => r.result && r.turn !== undefined && r.turn < 3);
    expect(results.map((f) => f.title)).toEqual(earlier.map((r) => r.headline));
    expect(reasoningFor(m, t3)).toBeTruthy();

    const orch = m.columns[0]!;
    const final = orch.rows.at(-1)!;
    expect(final.kind).toBe('report');
    const reports = factsFor(m, final).filter((f) => f.kind === 'report');
    expect(reports.map((f) => f.title)).toEqual(
      expect.arrayContaining(['Report from Maintenance', 'Report from Passengers']),
    );
  });

  it('counts turns up to the viewed moment', () => {
    const m = deriveAgents(S01.agent);
    const orch = m.columns[0]!;
    expect(turnCount(orch.rows)).toBeGreaterThan(turnCount(orch.rows, orch.rows[2]!.seq));
  });
});
