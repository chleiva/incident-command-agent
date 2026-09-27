# Task 03 — Airline domain: mocked systems, tools, agent roles, scenarios & knowledge base

> Runs in parallel with 02, 04 and 05, after task 01 has been committed. Work on branch `task/03-domain`.

## 0. Read first

- `CLAUDE.md`: the standing rules, especially **anonymity**, **licensing** and **cost rules**.
- `docs/specification.md`: §6 (the tools and agents table), §7 (mocked systems, in full), §8 (scenario schema), §9 (data and knowledge, in full), §11 (the regulatory table: which actions are reserved to humans), and §13 (licensing and SOURCES.md).
- `packages/schema/CONTRACTS.md`, `src/systems.ts`, `src/scenario.ts` and `src/runtime.ts`: the types you implement against (`MockSystem`, `ToolDefinition`, `RoleDefinition`, `KnowledgeIndex`, `SystemMutation`, `Scenario`).

## 1. You own

```
services/run/systems/     7 mocked systems + record store (mne, occ, crew, pss, airport, handler, engineers, record)
services/run/tools/       one module per domain tool; index.ts exports `domainTools`
services/run/agents/      one role file per agent (orchestrator, maintenance, ground, flightops, passenger, record, author); index.ts exports `roles`
services/run/knowledge/   index loader + retrieval (BM25 + embeddings) implementing KnowledgeIndex
scenarios/public/         the 10 shipped scenarios (ids fixed in CLAUDE.md) + generated index
data/                     @ica/kb: kb:build pipeline, airports:build, SOURCES.md, small committed fixtures
```

**Do not edit** `services/run/{runtime,llm,world,guardrails,baseline}`, `services/run/index.ts` or `handler.ts` (task 02), `packages/*` (additive only, and report it), `services/api`, `infra` or `apps/web`. You consume the runtime through the tests only. Write your own light harness that calls tool handlers directly with a `ToolContext` built from `seedAll(scenario)`. You never need the agent loop to test your work.

## 2. Mocked systems (`systems/`), spec §7

Each module implements `MockSystem<Name>` from the contract: `seed(scenario, rng)`, `tick(state, simMinute, dtMin)` for modelled processes, `knownRefs(state)`, and pure helper functions the tools use. The rules are **enforced in the system**, not only in tool tiers:

| System | Seed from scenario | Rules and processes (unit-test each) |
|---|---|---|
| `mne` | aircraft, the trigger → an open defect, the MEL references in evidence | Work-order lifecycle: `created → assigned → in_progress → awaiting_certification → closed`, advanced by `tick` using `estimatedDurationMin` once an engineer is `on_site`. **Only an actor of `kind: 'human'` whose `roleTitle` contains "Certifying" can set a defect to `deferred` or an aircraft to `released`**; any other actor → an error. The agent can only create and read. |
| `occ` | rotation, spares, curfews | Swap requires a spare of a compatible type **at the same station**, available by STD − the minimum turn (35 min). Cancellation sets downstream flights of that tail to `cancelled` or `delayed` as the rotation implies. Reactionary delay propagates along the rotation (the next STD slips by the arrival delay minus buffer). The curfew blocks an ETD inside the curfew window. |
| `crew` | the crew list | `fdpUsedMin` grows with sim time after `reportTime`; `fdpRemainingMin = maxFdpMin − used − remaining planned sector time`. **Any extension beyond `maxFdpMin` is refused.** A standby assignment requires a matching rank and enough FDP for the remaining sectors. |
| `pss` | cohorts plus generated rebooking options (fictional `NWD` flights with seat counts) | EU261 tier by great-circle distance (≤1500 km €250; intra-EU >1500 km or 1500–3500 km €400; otherwise €600). Rebooking is only allowed onto flights with enough `seatsAvailable`, which it decrements. Messages record `sentAtMinute` and set cohort `firstInformedAtMinute`. |
| `airport` | stands, weather, curfews | A stand request confirms at `requestedAt + modelledDelay` (3–8 min, seeded) unless the stand is occupied → `rejected`. Tow, bus and stairs requests are ETA-based. The fire service is available for s09. |
| `handler` | handler staff, equipment, `ackMinutes` | Tasks are acknowledged after `ackMinutes` (± seeded jitter). Equipment pools decrement and restore. |
| `engineers` | the engineer roster | Paging sets `paged` → `travelling`, with an ETA from the station distance table: same airport walk 5–15 min; drive at 60 km/h + 20 min; fly = the next fictional positioning flight + 45 min. `tick` moves them to `on_site`. |
| `record` | (empty) | The timeline, report drafts (`forHumanReporter: true`), evidence packs. |

`seedAll(scenario, rng)` combines all the seeds. **All generated names are fictional**: use a seeded generator over curated first and last name lists that you make up, and never real employee data. Keep the systems pure, returning `SystemMutation[]`; the runtime (task 02) persists them.

## 3. Tools (`tools/`), one module per tool

Every module exports a `ToolDefinition` with `name`, `description` (written for the model; say when to use it and what it returns), `inputSchema` (strict, `additionalProperties: false`, bounded numbers, enums where possible, **no free-text fields that flow into mutations** except message and report bodies, which are output-screened), `tier`, `system`, `roles`, `mutates`, `refs` and `outputScreen` where relevant, plus the `handler`. Results are compact JSON; the runtime wraps them in `<tool_result source=…>`.

**Autonomy matrix. This is final; the evals and the UI rely on it:**

| Role | Tool | Tier | Notes |
|---|---|---|---|
| maintenance | `get_aircraft_status`, `get_open_defects` | execute | |
| maintenance | `search_mel` | execute | knowledge `mel`; returns citations |
| maintenance | `create_work_order`, `page_engineer` | execute | |
| maintenance | `draft_techlog_entry` | **propose** | `outputScreen: techlog`; `aiDrafted: true` |
| maintenance | `record_engineering_decision` | **propose** | captures the decision; the approving human becomes `decidedBy` |
| maintenance | `defer_defect`, `release_aircraft` | **forbidden** | exist so attempts are blocked and counted (safety gates) |
| ground | `get_stand_status`, `request_stand`, `request_tow`, `request_bus`, `notify_handler` | execute | |
| ground, maintenance | `search_procedure`, `get_weather` | execute | `get_weather` uses the scenario snapshot, or NOAA live when `FEATURE_LIVE_WEATHER=true` (aviationweather.gov data API, no key; `<tool_result>`-wrapped) |
| flightops | `get_rotation`, `find_spare_aircraft`, `get_crew_fdp`, `find_standby_crew` | execute | |
| flightops | `propose_swap`, `propose_cancel`, `assign_standby_crew` | **propose** | |
| flightops | `extend_crew_fdp` | **forbidden** | |
| passenger | `get_manifest_summary`, `estimate_eu261_exposure`, `search_passenger_rights` | execute | |
| passenger | `draft_passenger_message` | execute | `outputScreen: passenger_message`; stores a draft |
| passenger | `send_passenger_message`, `issue_care_vouchers`, `rebook_cohort` | **propose** | spec §11: care and rebooking affect people → human decision |
| record | `append_timeline`, `draft_occurrence_report`, `draft_discretion_report`, `export_evidence_pack` | execute | drafts are `forHumanReporter: true`; `outputScreen: report` |
| author | `validate_scenario`, `lookup_airport`, `search_precedents` | execute | |
| author | `web_search` | execute | only when `FEATURE_WEB_SEARCH=true` and a `TAVILY_API_KEY`/`BRAVE_API_KEY` secret exists; **domain allow-list** from spec §9; untrusted-wrapped |
| orchestrator | `open_incident`, `delegate`, `set_objective`, `request_decision`, `report` | — | **runtime tools, owned by task 02; don't implement them** |

Every role also gets the runtime's `report` tool; you define each role's `reportSchema`. `export_evidence_pack` assembles JSON (the timeline, decisions with approvers, messages sent, report drafts, KPI snapshot, citations). The UI (task 05) renders it to PDF.

Unit-test every tool: the happy path, rule violations surfacing as `{ok:false}`, ref-validation metadata, and mutations produced.

## 4. Agent roles (`agents/`)

One file per role exporting a `RoleDefinition`. **The system prompt is a constant string: never interpolate user or scenario text into it.** The runtime prepends task 02's `DATA_HANDLING_PREAMBLE`. Each prompt covers:
- The mission, in 3–5 sentences, and what "done" means (call `report`).
- The **authority boundary**, in plain words: which decisions belong to certifying staff, the commander, the duty manager, or passengers' own choices, and that tools enforce this anyway.
- Working style: act in parallel where independent, be concise, prefer tools over speculation, and cite knowledge for every MEL, rule or precedent claim (`sourceId`).
- Passenger-facing tone rules (passenger role): plain language, specific next step, time of next update, no blame, **never claim "extraordinary circumstances" or deny compensation**, and label the message as AI-drafted in its payload.
- The orchestrator: open the incident, set the objective, delegate to the specialists **concurrently** where independent, make sure the first passenger message goes out early (target < 15 sim minutes), use `request_decision` with ranked `DecisionOption`s when there are real alternatives (s04 especially), and track open issues until done.
- The author: turn free text into a schema-valid `Scenario` using only fictional carrier data and real IATA codes, and call `validate_scenario` until it's valid.

Keep the prompts tight. Tokens are money, and the prompt is cached but still counted.

## 5. The ten scenarios (`scenarios/public/*.json`)

The ids, titles, stations and key twists are fixed in CLAUDE.md, so use them exactly. For each scenario:
- A realistic, **fictional** narrative (Northwind Air, `NWD` flights, `NW-XXX` tails, real airports), a trigger with evidence, and a world rich enough for every specialist to have something to do: at least one spare candidate somewhere (none at the station for s04), engineers at varied distances, crew with realistic FDP margins (tight in s10), 3–6 passenger cohorts including PRM and connections, stands, handler equipment, weather and curfews.
- At least one scheduled twist and one manual twist.
- A **baseline chronology**: how a human team would plausibly handle it today, with realistic slower timings (first passenger message around minute 25–40, phone-driven engineer paging and so on), using the same tool names.
- `expected` constraints (for example `noSoftwareDeferral: true`, `firstPaxMessageBeforeMin: 15`, ordered pairs like `["page_engineer", "propose_swap"]`), and a `referenceSummary`.
- `kpiParams` using the spec defaults (€100/min, factor 1.8, €18,600 cancellation), overridden where justified.
- `inspiredBy`: **real ASRS ACN numbers (or AAIB report URLs) that you actually found in the downloaded corpus**, each with a one-line note. **Never invent report ids.** If you can't verify one, leave the list empty and flag it in your final report.
- It must validate with `npm run scenarios:validate`. Regenerate `scenarios/public/index.gen.ts`.

Also `scenarios/README.md`: how to write a scenario, and the private-scenario workflow (`scenarios/private/` is git-ignored; `npm run scenarios:push` is owned by task 04).

## 6. Knowledge base (`data/` = `@ica/kb`, `services/run/knowledge/`), spec §9

`npm run kb:build` is resumable and idempotent. Each source is its own step, and **a failing source warns but doesn't fail the build**:

| Collection | Sources (spec §9) | Notes |
|---|---|---|
| `precedent` | NASA ASRS via the Hugging Face dataset `elihoole/asrs-aviation-reports` (download parquet or CSV through the HF datasets server). **Filter** to ground, pre-departure and maintenance-relevant narratives (keywords: pushback, tug, towbar, catering, GSE, bird, lightning, door, slide, hydraulic, fuel spill, brake, APU, MEL, deferral, stand) and cap at around 4,000 reports. UK AAIB bulletins (scrape the gov.uk listing politely: rate-limited, with a user agent, and a cap of about 150 ground-event reports). FAA AIDS CSV (supplementary). | Keep NASA's disclaimer in the metadata and in `SOURCES.md` |
| `mel` | FAA A320 MMEL PDF | Extract items: number, title, category, dispatch conditions (verbatim; public domain) |
| `rules` | EASA Easy Access Rules for Air Operations: extract only ORO.MLR.105, ORO.FTL (including .205) and CAT.GEN.MPA.105 | Attribution |
| `procedure` | FAA AC 150/5210-20A, UK CAA CAP 642, Airbus Safety First ground-ops articles | CAA and Airbus acknowledgement. **The FSF template is excluded by default** (redistribution unconfirmed): set `KB_INCLUDE_FSF=true` for local use only |
| `passenger_rights` | EU Regulation 261/2004 (EUR-Lex), UK CAA passenger-rights pages | |
| (params) | EUROCONTROL Standard Inputs cost-of-delay tables → `data/params/delay-cost.json` | Cited as the KPI default source |

- Pipeline: download to `data/raw/` (git-ignored) → extract text (use `unpdf` or `pdfjs-dist` for PDFs, `cheerio` for HTML) → chunk to about 500 tokens with metadata `{chunkId, sourceId, url, title, section, jurisdiction, date, collection, licence}` → BM25 statistics → embeddings → write `data/index/` (the chunks as compact JSONL, BM25 postings, and int8-quantised embeddings). **The total must be under 50 MB.** `npm run kb:upload` (task 04) syncs it to S3.
- **Embeddings are pluggable** through `KB_EMBEDDINGS`:
  - `local` (the default): `@huggingface/transformers` with a small sentence model such as all-MiniLM-L6-v2. It's free and needs no key, and the same model embeds queries at runtime. Check that the Lambda bundle and cold start stay acceptable; if they don't, cache the model files alongside the index in S3.
  - `openai`: `text-embedding-3-small`.
  - `bedrock`: Titan.
  - `none`: BM25 only, which is always a valid fallback.
- Retrieval (`services/run/knowledge/`) implements `KnowledgeIndex.search` as a hybrid: BM25 plus cosine, fused with reciprocal rank fusion, filtered by collection and jurisdiction. Loading reads from `fs` (local) or S3 (Lambda), and the loaded index is cached for the container's lifetime. It must return in under 300 ms on a warm Lambda. The tools turn hits into `Citation {sourceId, url, title, quote (≤ 300 chars, verbatim from the chunk), chunkId}`.
- `data/SOURCES.md`: for every source, the URL, retrieval date, licence, attribution text, and whether verbatim reuse is allowed. Paraphrase where it isn't.
- `data/fixtures/`: a **small committed mini-corpus** (about 30 chunks across all collections, public-domain or permitted text only, plus a tiny prebuilt index). Unit tests and CI use it, so they need no network, and the eval harness uses it for `knowledgeInjection` overrides.
- `npm run airports:build`: download OurAirports `airports.csv` → write `data/airports/stations.json` (committed: IATA, name, lat/lon and country for European large and medium airports plus every station in the scenarios) and export `distanceKm(a, b)` (haversine) from `@ica/kb`. The API (task 04) serves the stations in `/config`.

## 7. Cost rules while you build

Nothing in this task needs live LLM calls, except optionally prompt-tuning a role with `run:local` once task 02 lands (Haiku, `RUN_BUDGET_USD=0.50`). Embedding with `local` is free. If you use the OpenAI or Bedrock embedding options, report the spend.

## 8. Definition of done

- [ ] All 7 systems plus `record` are implemented, and every rule in the table above is unit-tested.
- [ ] All tools in the autonomy matrix are implemented and unit-tested; `domainTools` exports them all, with tiers exactly as specified.
- [ ] 7 role files with constant prompts and report schemas; `roles` is exported.
- [ ] 10 scenarios validate; the index is regenerated; `inspiredBy` holds verified references, or is empty and flagged.
- [ ] `npm run kb:build` produces an index under 50 MB from a clean machine, with per-source failures tolerated; `SOURCES.md` is complete; the fixture mini-corpus and index are committed; `npm run airports:build` works; `stations.json` is committed.
- [ ] Retrieval tests on the fixture corpus: an MEL query returns the MEL chunk with a citation, jurisdiction filtering works, and BM25-only mode works.
- [ ] `npm test -w @ica/run -w @ica/kb -w @ica/scenarios` passes with no network.
- [ ] Final report: contract changes, unverified `inspiredBy` items, sources that failed to download, the index size, and embedding choice and cost.
