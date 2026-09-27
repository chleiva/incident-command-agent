# ADR 0006 — Lifetime £10 budget for live evaluation

Status: accepted · 2026-09-26

## Context
The owner's hard requirement: **total spend on live evaluation, ever, must not exceed £10.** This is a lifetime cap across all invocations, not per run. The spec's "6-case smoke on every PR and the full set nightly" would exhaust it within days.

## Decision
- A committed, append-only ledger `evals/ledger.json` records every live invocation (`reserved` then `settled`, with USD and GBP amounts). Remaining budget = cap − settled − open reservations.
- The cap is a constant in code (`LIFETIME_CAP_GBP = 10`); `EVAL_LIFETIME_CAP_GBP` may lower it, never raise it. No override flag.
- Reserve-then-settle accounting: reserve the worst case before any call; settle with actual usage × `config/pricing.json` × a 1.10 safety margin. A crash leaves the reservation in place. `GBP_USD_RATE` is deliberately low (conservative).
- Pre-flight worst-case check against the remaining budget, interactive confirmation, and a per-case `RUN_BUDGET_USD` hard stop.
- **Record once, replay forever:** live spend only records traces and judge verdicts; every later eval replays them at £0 (`replay` tier, the default).
- **No live evals in CI.** CI runs only the free `replay` and `baseline` tiers. Live runs are local, need `--live` plus confirmation and the owner's explicit go-ahead, and the ledger is committed right after.

## Consequences
- One planned live smoke recording (integration pass); further live runs only on request and truncated to what fits.
- The harness refuses to start if the ledger has uncommitted changes.
- `npm test` never makes live calls.
