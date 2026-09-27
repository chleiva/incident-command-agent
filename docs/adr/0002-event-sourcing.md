# ADR 0002 — Event sourcing as the single source of truth

Status: accepted · 2026-09-26

## Context
The UI must show every effect live, replay gap-free after a refresh, and time-travel with a scrubber. Evals must score trajectories. Approvals and twists arrive from the API while the Run Lambda is running.

## Decision
Every agent step, tool call, world tick, KPI update, mutation, approval and control request is an event row (`RUN#{id}` / `EVT#{seq:08d}`) with a gap-free per-run `seq`. Mock-state rows (`SYS#…`) are written **in the same DynamoDB transaction** as the `system.mutation` event that describes them. The UI, the evals and the API derive state with one pure reducer, `applyEvent` in `@ica/schema`. The API writes `approval.decision`, `twist.requested` and `control.requested` as events; the Run Lambda drains them on each iteration.

## Consequences
- A refresh is `GET /events?after=0` plus the WebSocket; the scrubber is a fold to any seq.
- `Store.append` is the only write path; it serialises concurrent writers (Run Lambda and API) with an optimistic `lastSeq` condition.
- The event contract is frozen: payloads evolve additively only.
