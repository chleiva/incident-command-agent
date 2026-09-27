# ADR 0004 — Single-table DynamoDB

Status: accepted · 2026-09-26

## Context
Serverless only, zero idle cost (NFR-01), ordered and streamable events, atomic event + state writes, and a handful of small access patterns (runs, events, approvals, mock state, connections, scenarios, eval reports).

## Decision
One on-demand table with `PK`/`SK`, a stream (NEW_IMAGE), TTL attribute `ttl` (30 days on events) and one GSI (`GSI1PK`/`GSI1SK`, projection ALL). Layout (see `packages/store/src/keys.ts`): `SCN#{id}/META`, `RUN#{id}/META`, `RUN#{id}/EVT#{seq:08d}`, `RUN#{id}/APR#{id}`, `RUN#{id}/SYS#{system}#{entity}#{id}`, `WS#{conn}/RUN#{id}` (GSI1 `RUN#{id}`/`WS#{conn}` for fan-out), `EVAL#{id}/META`. GSI1 also indexes runs (`RUNS`/`{createdAt}#{runId}`), scenarios (`SCN`/`{id}`) and evals (`EVAL`/`{createdAt}#{id}`) so no access pattern needs a Scan. Payloads over 32 KB go to S3 (`traces/{runId}/{seq}.payload.json`) with a preview inline.

## Consequences
- Events and their state changes commit in one `TransactWriteItems` (≤ 100 items; larger batches are split per event).
- The fan-out Lambda filters the stream to `SK` beginning with `EVT#`.
- Hot partitions are not a concern at single-user scale.
