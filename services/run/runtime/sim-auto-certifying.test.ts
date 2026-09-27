/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** The simulation safety net never approves a certifying-staff decision: it closes it as not decided. */
import { SIMULATION_AUTO_ACTOR, type ApprovalRecord } from '@ica/schema';
import { MemoryStore } from '@ica/store';
import { describe, expect, it } from 'vitest';
import { applySimulationAutoApproval, CERTIFYING_TOOLS } from './approvals';
import type { RunContext } from './context';

function setup(tool: string) {
  const store = new MemoryStore({ validate: false } as never);
  const record: ApprovalRecord = {
    runId: 'r1',
    approvalId: 'apr-1',
    status: 'pending',
    agentRunId: 'ar-maintenance-1',
    role: 'maintenance',
    toolCallId: 'tu_1',
    tool,
    args: {},
    summary: 'Record the engineering decision',
    proposalSeq: 1,
    createdAtMinute: 5,
  };
  const emitted: { type: string; payload: Record<string, unknown> }[] = [];
  const ctx = {
    runId: 'r1',
    deps: { store },
    emit: async (type: string, payload: Record<string, unknown>) => {
      emitted.push({ type, payload });
      return { seq: 2, wallTime: '2026-09-27T20:00:00Z' };
    },
  } as unknown as RunContext;
  return { store, record, ctx, emitted };
}

describe('simulation safety net and certifying decisions', () => {
  it('lists record_engineering_decision as certifying-only', () => {
    expect(CERTIFYING_TOOLS.has('record_engineering_decision')).toBe(true);
  });

  it('closes an engineering decision as NOT decided (reject with reason), never approved', async () => {
    const { store, record, ctx, emitted } = setup('record_engineering_decision');
    await store.putApproval(record);
    expect(await applySimulationAutoApproval(ctx, record)).toBe(true);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      type: 'approval.decision',
      payload: { decision: 'reject', decidedBy: SIMULATION_AUTO_ACTOR },
    });
    expect(String(emitted[0]!.payload.reason)).toMatch(/certifying staff/);
    expect(await store.getApproval('r1', 'apr-1')).toMatchObject({ status: 'rejected' });
  });

  it('still approves ordinary proposals', async () => {
    const { store, record, ctx, emitted } = setup('send_passenger_message');
    await store.putApproval(record);
    expect(await applySimulationAutoApproval(ctx, record)).toBe(true);
    expect(emitted[0]).toMatchObject({ payload: { decision: 'approve' } });
    expect(await store.getApproval('r1', 'apr-1')).toMatchObject({ status: 'approved' });
  });
});
