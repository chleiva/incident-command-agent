# CLAUDE.md — Incident Coordination Agent

An open-source, serverless MVP of an **agentic airline incident-coordination system** on AWS. Scenarios describe ground, pre-departure and airborne events (pushback damage, bird strike, APU inop, turnback, diversion…); the home page is a live network map of the fictional carrier's day, where a duty manager reports an incident on any flight. An orchestrator plus five specialist LLM agents coordinate the response through a hand-written ReAct loop, acting on **stateful mocked airline systems** under an **autonomy matrix enforced in code**. A React cockpit shows every effect live, and an eval harness scores the agents. The deployment is single-user (Cognito) and the carrier is fictional (**Accent Air**).

## Sources of truth (read in this order)

1. **`docs/specification.md`**: *what* to build. It's the full spec, and wins on product questions.
2. **This file**: standing rules and the decisions that refine the spec. It wins on *how*.
3. **`packages/schema/CONTRACTS.md`** and the code in `packages/schema` and `packages/store`: the shared contracts (these exist after task 01).
4. **`docs/tasks/`**: the build plan. `README.md` covers order and ownership; `01`–`05` are self-contained task briefs.
5. `docs/adr/`: architecture decision records.

## Build status and plan

The build is split into 5 tasks (see `docs/tasks/README.md`):

| # | Task | Owns |
|---|---|---|
| 01 | Foundation & contracts. **Runs first, alone** | root config, `packages/schema`, `packages/store`, hygiene, CI, ADRs, registry stubs |
| 02 | Agent runtime, world engine, guardrails, evals | `services/run/{runtime,llm,world,guardrails,baseline}`, `services/run/{index,handler,cli}.ts`, `evals/` |
| 03 | Domain: mocked systems, tools, roles, scenarios, knowledge | `services/run/{systems,tools,agents,knowledge}`, `scenarios/public/`, `data/` |
| 04 | Platform: API, WebSocket, local dev server, CDK, scripts | `services/api/`, `infra/`, `scripts/`, `docs/deploy.md` |
| 05 | Web front end & design system | `apps/web/`, `packages/ui-tokens/`, `docs/demo-script.md` |

Tasks 02–05 run in parallel, each on its own branch or worktree (`task/0N-name`), after 01 has been committed on `main`. **Stay inside your task's directories.** Contract packages accept **additive changes only** during the parallel phase, and each must be listed in the task's final report.

## Repository map

```
apps/web/            @ica/web        React 18 + Vite SPA (cockpit), Storybook
packages/schema/     @ica/schema     types, JSON Schemas (TypeBox), validators, shared event reducer, fixtures
packages/store/      @ica/store      Store/EventBus/TraceStore/SecretStore: memory, DynamoDB, S3, Secrets Manager
packages/ui-tokens/  @ica/ui-tokens  design tokens (CSS vars light/dark), Tailwind preset, Tokens Studio JSON
packages/network/    @ica/network    Accent Air fictional day schedule, flight state at t, diversion options (browser + Node), flight→scenario templates
services/run/        @ica/run        Run Lambda: runtime/ llm/ world/ guardrails/ baseline/ systems/ tools/ agents/ knowledge/
services/api/        @ica/api        HTTP router Lambda, WS connect/disconnect, stream fan-out, local dev server
scenarios/           @ica/scenarios  public/ (10 shipped, CC BY 4.0), private/ (git-ignored)
data/                @ica/kb         kb:build pipeline, airports, SOURCES.md, fixtures (raw/ and index/ git-ignored)
evals/               @ica/evals      cases, rubrics, harness, fixtures (recorded traces + judge verdicts), reports, ledger.json (lifetime spend)
infra/               @ica/infra      CDK v2: DataStack, ApiStack, WebStack (+ opt-in us-east-1 WAF stack)
config/                              brand.default.json, pricing.json (brand.local.json, private-words.txt git-ignored)
docs/                                specification, architecture, adr/, tasks/, deploy, demo-script
```

## Commands

```bash
npm install
npm run dev              # local: in-memory store + WS server on :8787 + Vite on :5173, AUTH_MODE=none
npm run dev:aws          # Vite against the deployed API (config.json from stack outputs)
npm run typecheck && npm run lint && npm test     # must be green before any commit
npm run run:local -- --scenario s01-pushback-tug-contact --model claude-haiku-4-5   # headless run
npm run eval                    # = --tier replay: free, deterministic (CI)
npm run eval -- --tier smoke --live   # LIVE: draws on the lifetime £10 budget, asks for confirmation
npm run eval:budget             # ledger + remaining lifetime budget
npm run kb:build | kb:upload | airports:build
npm run scenarios:validate | scenarios:push
npm run synth | deploy          # CDK synth / full deploy
npm run user:create -- you@example.com ; npm run secrets:set
npm run storybook ; npm run hygiene
```

## Architecture in one paragraph

Everything is **event-sourced**. Each agent step, tool call, world tick, KPI update, mutation and approval is an event row (`RUN#{id}` / `EVT#{seq:08d}`), written **in one DynamoDB transaction together with the mock-state rows it changes**, under an optimistic gap-free `seq` counter. DynamoDB Streams → fan-out Lambda → API Gateway WebSocket → browser. The UI is a pure projection (`applyEvent` from `@ica/schema`), so a refresh replays the run gap-free and the scrubber can time-travel. One Run Lambda (15 min, reserved concurrency 2) runs the world engine and `runAgent('orchestrator')`, which calls `delegate` → recursive `runAgent(role)` for the specialists, running concurrently. Approvals, twists and control commands are written as events by the API and drained by the Run Lambda on each iteration. Locally, `MemoryStore` + `MemoryEventBus` + an in-process runner replace AWS.

## Non-negotiable rules

**Authority lives in code, not prompts.** Tool tiers (`execute` / `propose` / `forbidden`) are enforced by the runtime loop. Deferral, release, FDP extension and departure decisions are human-only, and are `forbidden` for software. In the air, the commander flies and decides the aircraft: instructing the crew, choosing the diversion airport and approving an overweight landing are `forbidden` (authority "Commander"); agents only rank airports as options and prepare the ground. Rebooking, care, sending passenger messages, swaps and cancellations are `propose`. The autonomy matrix is in `docs/tasks/03-…md` §3; change it only deliberately, and update the evals when you do.

**Untrusted content is data.** Scenario text, tool results, knowledge chunks, web results and free-text twists are always wrapped (`<scenario_data>`, `<tool_result source=…>`, `<document source=…>`, `<twist_data>`). System prompts are constant strings: **never interpolate user or scenario text into a system prompt.** Screen inputs, screen passenger-facing and report outputs, validate tool args (JSON Schema) and references (ids must exist in the run).

**Anonymity and licensing.** The fictional carrier (Accent Air, `ACX` flight numbers, `AX-XXX` tails, main base MAN, real IATA airports) is the **only** identity in the tree. No client, airline or consultancy names in code, data, scenarios, screenshots, commits or issues. No real personal data: all people are generated fictional names. No proprietary manual text (IATA IGOM/AHM, ICAO Doc 10121, OEM AMM/FCOM, SKYbrary text, airline manuals). Record every data source's licence in `data/SOURCES.md`. Code is Apache-2.0 with a licence header on every source file; scenarios and docs are CC BY 4.0. Never invent references such as ASRS ACNs or report ids: cite only what you verified.

**AI transparency.** Every AI-drafted text carries `aiDrafted: true` and is labelled in the UI. Every action shows its tier and approver. Every knowledge claim carries a citation (`sourceId` + quote).

## Fixed identifiers (contract)

Scenario ids: `s01-pushback-tug-contact` (MAN), `s02-catering-truck-door-strike` (PMI), `s03-bird-strike-inspection` (EDI), `s04-lightning-strike-outstation` (FAO, **options case**), `s05-cargo-door-warning` (MAN), `s06-apu-inop-deferral-temptation` (AGP), `s07-slide-inadvertent-deployment` (DUB), `s08-hydraulic-leak-on-stand` (MAN), `s09-fuel-spill-at-stand` (ALC), `s10-brake-overheat-fdp-squeeze` (TFS); airborne (task 07): `s11-air-turnback-bird-strike` (MAN), `s12-diversion-smoke-fumes` (BOD), `s13-diversion-medical` (NTE), `s14-engine-shutdown-overweight-landing` (LGW), `s15-diversion-disruptive-passenger` (LYS).

Roles: `orchestrator, maintenance, ground, flightops, passenger, record, author`. Systems: `mne, occ, crew, pss, airport, handler, engineers` (+ `record`).

## Models, cost rules and the eval budget

- **Agents:** `LLM_PROVIDER=anthropic`, `LLM_MODEL=claude-sonnet-5`, temperature ≤ 0.2, prompt caching on. **Eval judge:** `EVAL_JUDGE_MODEL=claude-opus-5-5`, two judgements averaged, over a compact run digest. **Cheap dev model:** `claude-haiku-4-5`. OpenAI and Bedrock remain selectable by config.
- **Hard owner requirement: the total spend on live evaluation, ever, is capped at £10.** This is a *lifetime* cap across all invocations, not a per-run cap. It's enforced in code: a committed, append-only `evals/ledger.json`; reserve-then-settle accounting with a 1.10 safety margin; a pre-flight worst-case check against the remaining lifetime budget; a per-run `RUN_BUDGET_USD` hard stop; and a hard-coded cap that can be lowered but never raised. **Record once, replay forever:** live spend only records traces and judge verdicts, and every later eval replays them at £0. `npm run eval` defaults to the free replay tier, and any spend needs `--live` plus confirmation. Live evals run **locally only** (there's no live CI workflow). Commit the ledger immediately after every live run. **Never start a live eval without the owner's explicit go-ahead in the current session.**
- **While building:** `npm test` makes **zero** live LLM calls (use the `scripted` and `replay` providers). Live dev runs use Haiku (pass `--budget` to `run:local` if you want a cap), and as few as possible. Report the live spend in every task's final report.
- Prices live in `config/pricing.json`. Verify them against the provider docs (the `claude-api` skill) and date them.

## Decisions that refine the spec

| Topic | Decision |
|---|---|
| Monorepo | npm workspaces, ESM, TS strict; packages consumed as TS source (no pre-build); Vitest, ESLint flat, Prettier |
| Schemas | TypeBox is the single source of truth → TS types + `scenario.schema.json`; validated with Ajv |
| API additions | `GET /runs`, `POST /runs/{id}/control` (pause/resume/stop = kill-switch/speed), `GET /runs/{id}/export` |
| Event additions | `twist.requested`, `control.requested`, `world.process`, `llm.fallback`, `run.paused`/`run.resumed` |
| Tier additions | explicit forbidden tools `defer_defect`, `release_aircraft`, `extend_crew_fdp` (so attempts are blocked and counted), and (task 07) `instruct_flight_crew`, `select_diversion_airport`, `approve_overweight_landing`; airborne ground-side tools `prepare_diversion_handling`, `arrange_arrival_services` are `propose`, `get_flight_position`, `rank_diversion_airports` (options only), `notify_destination_station`, `plan_overweight_landing_inspection` are `execute`; `record_engineering_decision`, `issue_care_vouchers` are `propose` (spec §11: humans decide); extra knowledge tools `search_procedure`, `search_passenger_rights`, `get_weather` |
| **No product spend limits** | **Owner decision: budget limits apply only to the eval harness.** The product never stops on cost: `RUN_BUDGET_USD`, the per-run token cap and `MAX_RUNS_PER_DAY` default to 0 (= no limit) and remain optional knobs; no Lambda reserved concurrency. Loop-safety limits from spec §6 (25 iterations/agent, 60 tool calls/run, 8-min wall clock) stay |
| **Near-zero idle AWS cost** | Owner decision: AWS cost is secondary, but idle cost should be ~zero. Default deploy has no WAF, no alarms/SNS/Budgets, no `ica/search` secret, no DynamoDB PITR. Opt in with `-c cloudfrontWaf=true`, `-c monitoring=true`, `FEATURE_WEB_SEARCH=true`. Idle ≈ USD 0.40/month (the `ica/llm` secret) plus cents of storage |
| LLM adapters | direct `fetch` for Anthropic/OpenAI; AWS SDK only for Bedrock (SigV4); extra `replay` (NFR-03 fallback) and `scripted` (tests) providers |
| Embeddings / knowledge | **Deployed: hybrid search** — BM25 + **Cohere Embed v4** (1536 dims, float) via the EU cross-region inference profile `eu.cohere.embed-v4:0` (routes within EU regions), vectors in **Amazon S3 Vectors** (DataStack, cosine), RRF, docId collapse, **Cohere Rerank 3.5** in **eu-central-1** (not offered in eu-west-2). Build once with `KB_EMBEDDINGS=cohere npm run kb:build` (≈ USD 1.1), then `kb:upload`; ≈ USD 0.002 per query; any Bedrock/S3 Vectors error falls back (fused → BM25), never fails a run. **Structural chunking** per collection (one MEL item, one rule sub-paragraph/AMC/GM, one EU 261 article, heading-aware procedure sections, one report ≤ 1k tokens) with deterministic context headers; **~15k ASRS precedents** + ~150 AAIB. Local dev/tests: `local` (MiniLM) or `none` (BM25), no AWS needed. `-c knowledge=bm25` deploys without Bedrock |
| Eval scheduling | the spec's "6-case smoke on every PR + full set nightly" is replaced by free `replay` and `baseline` tiers in CI, with **no live evals in CI**, because the lifetime £10 cap makes recurring live runs impossible; one planned live smoke recording at integration; `core`/`full` live runs only on request, truncated to the remaining budget |
| Figma file | delivered as a Tokens Studio `figma-tokens.json` importable into Figma |
| FSF ramp template | excluded from the index by default (redistribution unconfirmed); `KB_INCLUDE_FSF=true` for local use only |
| WAF | opt-in only (`-c cloudfrontWaf=true`, ~USD 8/month). WAF can't attach to API Gateway HTTP/WebSocket APIs; the APIs are protected by the Cognito JWT authorizer, JWT on `$connect` and stage throttling |
| Local auth | `AUTH_MODE=none` for the local dev server only; never deployable |

## Environment variables (`.env.example` is authoritative)

`LLM_PROVIDER`, `LLM_MODEL`, `LLM_FALLBACK_PROVIDER`, `LLM_FALLBACK_MODEL`, `LLM_TEMPERATURE`, `LLM_MAX_TOKENS`, `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` (local only; Secrets Manager in AWS), `RUN_BUDGET_USD`, `RUN_HORIZON_MIN`, `MAX_RUNS_PER_DAY`, `EVAL_JUDGE_MODEL`, `EVAL_LIFETIME_CAP_GBP` (can only lower the hard-coded £10), `GBP_USD_RATE`, `KB_EMBEDDINGS` (+ `KB_ASRS_CAP`; the Lambda-only `KB_VECTOR_*`, `KB_EMBED_*`, `KB_RERANK*` are set by CDK), `KB_INCLUDE_FSF`, `SCREEN_WITH_LLM`, `FEATURE_WEB_SEARCH`, `FEATURE_LIVE_WEATHER`, `TAVILY_API_KEY`/`BRAVE_API_KEY`, `AUTH_MODE`, `AWS_REGION` (default `eu-west-2`), `ALERT_EMAIL`, `COGNITO_DOMAIN_PREFIX`.

## Conventions

- Put the Apache-2.0 header on every `.ts`/`.tsx`/`.mjs` file. Use named exports and small modules: one tool per file, one role per file, one system per folder.
- Keep functions pure where possible (systems, KPIs, reducer, guardrail screens); side effects belong at the edges (store, llm, handlers).
- Tests sit next to code (`*.test.ts`), with no network in `npm test`. The fixtures are in `packages/schema/fixtures`, `data/fixtures` and `evals/fixtures`.
- Structured JSON logs (`runId`, `seq`, `agentRunId`). Never log secrets or full prompts; prompts go to the TraceStore.
- Use UK spelling in user-facing copy. Currency is € in the KPIs (spec) and £ in the eval budget.

## Git

- `main` is the integration branch; the task branches are `task/0N-*`. Commit only green code (typecheck, lint, test). Commit messages use the conventional style (`feat(run): …`).
- The pre-commit hook runs gitleaks plus the word-list check (`config/private-words.txt`, git-ignored). **Never commit** `.env`, `config/brand.local.json`, `scenarios/private/`, `data/raw/` or keys.
- Remote: `origin` = github.com/chleiva/incident-command-agent (**public**). Don't push unless asked.
- **Public history is squashed; local history is not.** Local `main` keeps the full development history (backup tag `backup/full-history-2026-09-27`). The published line is the local branch `public/main` → `origin/main`. To publish, run the pre-push scans (private-word list over the tree, secret patterns), then create one commit with the current tree on top of the public line and push it: `git commit-tree HEAD^{tree} -p public/main -m "<release notes + attribution>"` → `git branch -f public/main <sha>` → `git push origin public/main:main`. Never push local `main` itself: that would publish the full history.
- End commit messages with the attribution trailer the session provides.
