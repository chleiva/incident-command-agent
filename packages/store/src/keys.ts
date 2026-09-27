/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * DynamoDB single-table key layout (spec §5). Table: PK/SK strings, GSI1 (GSI1PK/GSI1SK, projection ALL),
 * TTL attribute `ttl`, stream NEW_IMAGE.
 *
 * | Entity     | PK              | SK                          | GSI1PK        | GSI1SK                 |
 * |------------|-----------------|-----------------------------|---------------|------------------------|
 * | Scenario   | SCN#{id}        | META                        | SCN           | {id}                   |
 * | Run        | RUN#{id}        | META                        | RUNS          | {createdAt}#{runId}    |
 * | Event      | RUN#{id}        | EVT#{seq:08d}               | –             | –                      |
 * | Approval   | RUN#{id}        | APR#{approvalId}            | –             | –                      |
 * | Mock state | RUN#{id}        | SYS#{system}#{entity}#{id}  | –             | –                      |
 * | Connection | WS#{connId}     | RUN#{id}                    | RUN#{id}      | WS#{connId}            |
 * | Eval       | EVAL#{id}       | META                        | EVAL          | {createdAt}#{id}       |
 * | Draft      | DRAFT#{id}      | META                        | –             | –                      |
 */
import { eventSortKey } from '@ica/schema';

export const META = 'META';
export const scenarioPk = (id: string) => `SCN#${id}`;
export const runPk = (runId: string) => `RUN#${runId}`;
export const eventSk = (seq: number) => eventSortKey(seq);
export const approvalSk = (approvalId: string) => `APR#${approvalId}`;
export const sysSk = (system: string, entity: string, id: string) => `SYS#${system}#${entity}#${id}`;
export const connectionPk = (connectionId: string) => `WS#${connectionId}`;
export const evalPk = (id: string) => `EVAL#${id}`;
/** Addition (async authoring): Training author drafts (TTL `DRAFT_TTL_DAYS`). */
export const draftPk = (id: string) => `DRAFT#${id}`;
export const DRAFT_TTL_DAYS = 1;

export const GSI1 = 'GSI1';
export const GSI1_SCENARIOS = 'SCN';
export const GSI1_RUNS = 'RUNS';
export const GSI1_EVALS = 'EVAL';

export const EVENT_TTL_DAYS = 30;
/** Payloads above this (serialised) size go to the TraceStore; the row keeps a preview + `payloadKey`. */
export const MAX_INLINE_EVENT_BYTES = 32 * 1024;
/** DynamoDB TransactWriteItems limit. */
export const MAX_TRANSACTION_ITEMS = 100;

/** Parse `SYS#{system}#{entity}#{id}` (ids may contain '#'). */
export function parseSysSk(sk: string): { system: string; entity: string; id: string } | null {
  const m = /^SYS#([^#]+)#([^#]+)#(.+)$/.exec(sk);
  return m ? { system: m[1], entity: m[2], id: m[3] } : null;
}
