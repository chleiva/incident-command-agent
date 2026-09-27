# Ground Incident Coordination Agent — Solution Specification

26 Sept 2026 · Christian Leiva Beltran

Requirements and solution design for an open-source, serverless MVP of an agentic airline incident-coordination system on AWS: React front end on CloudFront, API Gateway + Lambda + DynamoDB back end, a hand-written ReAct agent loop calling Anthropic or OpenAI directly, stateful mocked airline systems, a scenario engine, an evaluation harness and single-user Cognito security.

> This file is the source of truth for *what* to build. Implementation decisions that refine it (contracts, budgets, ownership) live in `CLAUDE.md`, `docs/tasks/` and `docs/adr/`. Where those deliberately deviate from this spec, the deviation is listed in `CLAUDE.md` → "Decisions that refine the spec".

---

## 1. Purpose, scope and non-goals

Build a working, deployable MVP of an agentic incident-coordination system: a thin but complete vertical slice, serious in every layer except that the airline systems are mocked for airline ground and pre-departure events. It must run any scenario from a library or one written on the spot, drive real LLM agents through a hand-written ReAct loop with tool calling, act on stateful mocked airline systems, show every effect in a React UI, and score itself against an evaluation set. One user, one AWS account, `cdk deploy`, public repository.

**In scope:** scenario library and authoring agent; orchestrator plus five specialist agents; ~30 tools over seven mocked systems; world engine with clock, twists and baseline replay; KPI models (safety, customer, money, compliance); knowledge base built from open data; evaluation harness; Cognito-protected single-user deployment; CDK infrastructure; documentation for contributors.

**Non-goals:** integration with any real airline system; multi-tenant or multi-user operation; production-grade HA or DR; mobile UI; fine-tuning models; any content copied from proprietary manuals (IATA IGOM, ICAO Doc 10121, OEM AMM/FCOM); real passenger or employee personal data.

**Fictional identity by default:** the shipped carrier is "Northwind Air" with fictional tails and real airport codes; client and consultancy branding load from a git-ignored local pack (see section 13).

## 2. Requirements

| ID | Functional requirement | Acceptance |
|---|---|---|
| FR-01 | Load a scenario from the library or create one from free text via the Scenario Author agent | Any of 10 shipped scenarios and a typed paragraph produce a schema-valid scenario and start a run |
| FR-02 | Trigger the incident and stream agent activity (thought, tool call, result, proposal, approval) live to the UI | First event visible < 2 s after trigger; ordered, gap-free replay after browser refresh |
| FR-03 | Orchestrator delegates to Maintenance, Ground, Flight Ops, Passenger and Incident Record agents running in parallel | Each agent's steps are attributed and visible; run completes in < 4 min simulated first hour |
| FR-04 | Every tool call is classified execute / propose / forbidden by an autonomy matrix enforced in code, not in the prompt | Forbidden calls are blocked and logged; propose calls create an approval card |
| FR-05 | Human approval, edit or rejection of proposals from the UI | Agent continues with the human decision within one loop iteration |
| FR-06 | Tool calls mutate mocked systems; a System inspector shows each system's live state | Creating a work order appears in the M&E view; rebooking appears in PSS |
| FR-07 | World engine advances a simulated clock, applies twists, and recomputes KPI models each tick | Twist injected mid-run changes agent behaviour and dials |
| FR-08 | Baseline replay of the same scenario at scripted human pace, shown side by side | Cost, customer, compliance values for both runs on one screen |
| FR-09 | Knowledge tool answers MEL, procedure, passenger-rights and precedent questions from an open-data corpus with citations | Every knowledge answer carries a source id and quote |
| FR-10 | Evaluation harness runs the scenario set headless and reports scores | `npm run eval` produces a JSON and Markdown report |
| FR-11 | Branding pack switches airline and consultancy identity without code change | Public build shows Northwind Air; local pack shows client identity |

| ID | Non-functional requirement | Target |
|---|---|---|
| NFR-01 | Serverless only; zero idle cost beyond storage | < USD 5/month idle; < USD 2 per full scenario run |
| NFR-02 | Provider-agnostic LLM layer | Anthropic (default), OpenAI, Amazon Bedrock selectable by config |
| NFR-03 | Deterministic-enough runs | Temperature ≤ 0.2, pinned model ids, recorded-trace fallback |
| NFR-04 | Single-user security | Cognito login, JWT-authorised APIs, no public write paths, secrets in Secrets Manager |
| NFR-05 | Prompt-injection resistance | Untrusted content (scenario text, knowledge documents, mock data) never carries instructions to the agents; see section 11 |
| NFR-06 | Reproducible deployment | `cdk deploy` from a clean account in < 20 min with documented prerequisites |
| NFR-07 | Observability | Every run has a trace: prompts, tool calls, tokens, latency, cost, stored in DynamoDB and S3 |
| NFR-08 | Open-source hygiene | No client names, keys or proprietary text in history; licence headers; CI runs lint, unit tests and evals |

## 3. Architecture overview

Everything is serverless and event-sourced: every agent step, tool call, world tick and approval is a row in DynamoDB; DynamoDB Streams fan those rows out to the browser over a WebSocket, so the UI is a projection of the event log and a refresh replays it gap-free.

The browser loads the React app from CloudFront, signs in with Cognito, calls the HTTP API with a JWT to load scenarios, start runs and answer approvals, and receives live events over the WebSocket. One Run Lambda executes a whole scenario (world engine plus the ReAct loop for the orchestrator and specialists), calls the LLM provider directly, and writes every event and mock-system change to DynamoDB. Not drawn: S3 for the knowledge corpus and trace archives, Secrets Manager for provider keys, CloudWatch for logs and alarms.

| Concern | Choice | Why |
|---|---|---|
| Compute | Lambda (Node 22, TypeScript), one Run Lambda per scenario run, 15-min timeout | A run lasts 3–5 real minutes; no containers to manage |
| Streaming to UI | API Gateway WebSocket fed by DynamoDB Streams | Ordered, durable, replayable; no long-polling |
| State | DynamoDB single table, on-demand capacity | Zero idle cost; one table for scenarios, runs, events, approvals, mock state |
| LLM | Direct Anthropic Messages API (default), OpenAI Responses API, Bedrock Converse as option, behind one interface | Provider reliability and feature parity; no SDK lock-in |
| Agent framework | None; hand-written ReAct loop | Full control of tool schema, autonomy checks and traces |
| Knowledge | Curated open-data corpus in S3, chunked at build time, BM25 + small embedding index loaded by the Run Lambda | Sub-second retrieval, no vector database |
| Infra as code | AWS CDK v2 (TypeScript), three stacks | `cdk deploy` reproducibility; Terraform port welcome as a contribution |

## 4. Front end

The UI is the product. It must let a person with no aviation background understand an unfolding incident in ten seconds, let a duty manager act in one click, and make the agents' work visible without turning the screen into a log viewer. Stack: React 18 + TypeScript + Vite, static build on S3 behind CloudFront (origin access control, SPA fallback, strict security headers). Radix primitives with Tailwind and a token-based design system; Framer Motion for choreographed motion; SVG for map, Gantt and stand views; visx for sparklines; Zustand store fed by one WebSocket reducer; no server rendering.

**Design principles (2026 practice).**

| Principle | What it means here |
|---|---|
| One question per glance | Each zone answers exactly one question: How bad is it? What is happening? What needs me? Who is affected? What changed? |
| Decisions first | Anything awaiting a human sits in a fixed "Decision needed" rail at top-right with a countdown; nothing else competes with it |
| Progressive disclosure | Headline → card → detail drawer. Agent reasoning collapses to a one-line summary by default; expand for thought, tool call and raw result |
| Explainable numbers | Every KPI is clickable: it opens the formula, the inputs and the events that moved it ("why this number") |
| Motion with meaning | Animation only for state change: a flight bar re-flows, a cost counter ticks, a decision card slides in. 150–300 ms, reduced-motion respected |
| Calm density | Ops-room dark theme by default, light theme available; 8-pt grid; tabular numerals; four accent colours only (good, warning, critical, AI) |
| Time is a first-class axis | A timeline scrubber under the KPI strip lets anyone drag back through the event log and watch the screen reconstruct any moment (event sourcing makes this free) |
| Trust cues | AI-drafted text is labelled; every action shows its tier and approver; sources are one click away; a "simulated systems" badge is always visible |
| Accessible by default | WCAG 2.2 AA contrast, full keyboard operation, live-region announcements for new decisions, focus management on drawers |

**Layout (1920×1080 and ultra-wide; degrades to laptop).** A 12-column grid. Row 1: KPI strip (full width). Row 2: Network view (5 cols) · Ground view (4 cols) · Decision rail + agent activity (3 cols). Row 3: Passenger view (7 cols) · Timeline scrubber and System inspector tabs (5 cols). Any zone expands to full screen with `F`; `⌘K` opens a command palette (presenter actions, jump to event, switch scenario); `Space` pauses the world clock.

| Zone | Components | What it shows and why it matters |
|---|---|---|
| KPI strip | KpiStrip, KpiTile, WhyDrawer | Six tiles: incident clock, countdown to 3 h, cost meter (€, ticking), customer satisfaction gauge, compliance checklist, safety gates. Each tile shows current value, delta vs baseline ghost (small grey figure) and a 60-second sparkline. Colour only when a threshold is crossed |
| Decision rail | DecisionQueue, DecisionCard, DiffEditor | Pending proposals, most urgent first, with countdown, plain-language summary, the agent's reasoning on expand, and three actions: approve, edit (inline diff of the payload), reject with reason. Keyboard: A/E/R |
| Alternatives comparison | OptionsMatrix | When the agent enumerates options (outstation case): a ranked matrix — time to departure, cost, customer impact, compliance, constraints — with bar-in-cell encoding and the recommended row highlighted; selecting a row becomes the decision |
| Network view | NetworkMap, RotationGantt | Equal-area map of stations with the affected tail and spare candidates; below it the day's rotation for the tail as a Gantt where amber and red propagate along the line and recede when a swap is approved. Hover shows knock-on minutes per sector |
| Ground view | StandView | Top-down stand diagram: aircraft, tug, GSE, engineer with ETA path, spare on adjacent stand, stairs and bus requests appearing as they are confirmed |
| Agent activity | AgentStream, ToolCallCard, AgentAvatarRow | One collapsible stream per role, interleaved by time; cards show thought summary, tool name and arguments, result preview, tier badge, latency. Roles light up while working. Filter by role or event type |
| Passenger view | CohortBoard, PhoneMock, CommsLog | Cohorts as cards (connections, PRM, families, unaccompanied minors) with status; a phone mock-up renders the exact message sent, labelled AI-drafted; a comms log with timestamps |
| Timeline scrubber | TimeScrubber, EventMarkers | Horizontal timeline of the run with markers for trigger, decisions, messages, twists, baseline milestones; drag to time-travel; play/pause; speed control |
| System inspector | SystemTabs, EntityTable | One tab per mocked system with live tables and a change highlight on rows touched by the last tool call |
| Story captions | Narrator | Optional one-line captions generated from events ("Engineer paged — ETA 9 min") for audiences; toggle in the palette |
| Presenter palette | CommandPalette, ScenarioPicker, AuthorBox | Pick or write a scenario, trigger, inject twist, replay baseline, reset, toggle side-by-side |

**Side-by-side mode.** A split view runs the agent replay and the baseline replay in lock-step on one timeline, KPI strips stacked, so the value story is visual rather than claimed.

**States and resilience.** Skeletons on load, optimistic update on approvals, toast on reconnect, a "run ended" summary card with export (PDF evidence pack, JSON trace). If the WebSocket drops, the client polls `GET /runs/{id}/events?after=` until it returns.

**Event consumption.** On load the client calls `GET /runs/{id}/events?after=0` to hydrate, opens the WebSocket, and applies events by monotonically increasing seq; duplicates are dropped and a gap triggers a re-fetch from the last seq. The store keeps the full event array so the scrubber can rebuild state at any seq with a pure reducer. Branding: `GET /config` returns the active brand pack (name, logo, colours, station list); the public build falls back to the fictional carrier.

**Design system deliverables.** `packages/ui-tokens` (colour, type, spacing, motion tokens in CSS variables with light and dark values), a Storybook with every component in empty, loading, live and error states, and a Figma file mirroring the tokens for contributors.

## 5. Back end

**HTTP API (API Gateway HTTP API, JWT authorizer against Cognito).**

| Method and path | Lambda | Purpose |
|---|---|---|
| `GET /scenarios` · `GET /scenarios/{id}` | api | List and read library and private scenarios |
| `POST /scenarios/author` | api → author | Free text → Scenario Author agent → validated scenario |
| `POST /runs` | api | Create run from scenario id and mode (agent or baseline); invokes Run Lambda asynchronously |
| `GET /runs/{id}` · `GET /runs/{id}/events?after=` | api | Run status; ordered event page for hydration |
| `POST /runs/{id}/approvals/{approvalId}` | api | approve / edit / reject with optional edited payload; written as an event the Run Lambda polls |
| `POST /runs/{id}/twists` | api | Inject a twist by id or free text |
| `GET /runs/{id}/systems/{name}` | api | Current state of a mocked system |
| `GET /config` | api | Active brand pack and feature flags |
| `GET /evals/latest` | api | Last evaluation report |

**WebSocket API.** `$connect` validates the JWT from the query string and stores connectionId with the runId it subscribes to; `$disconnect` removes it. The fan-out Lambda is triggered by the DynamoDB stream on event rows, batches by run, and calls PostToConnection; stale connections are purged on GoneException.

**Run Lambda.** Memory 1,769 MB (one vCPU), timeout 15 min, reserved concurrency 2. Loads scenario, seeds the mock systems, starts the world clock at the configured speed (default 6×), runs the orchestrator loop, and on each iteration: drains pending approvals and twists, advances the world, recomputes KPIs, appends events. Each write is a transaction: the event row plus any mock-state change, with an atomic seq counter per run, so the stream never emits a state change without its event.

**DynamoDB single-table design (PK / SK).**

| Entity | PK | SK | Notes |
|---|---|---|---|
| Scenario | `SCN#{id}` | `META` | JSON body, visibility public/private, schema version |
| Run | `RUN#{id}` | `META` | scenario id, mode, status, clock, totals, cost |
| Event | `RUN#{id}` | `EVT#{seq:08d}` | type, agent, payload, sim time, wall time, tokens; TTL 30 days |
| Approval | `RUN#{id}` | `APR#{id}` | status, decision, edited payload |
| Mock state | `RUN#{id}` | `SYS#{name}#{entity}#{id}` | one row per work order, crew member, passenger cohort, stand request |
| Connection | `WS#{connectionId}` | `RUN#{id}` | GSI on run id for fan-out |
| Eval | `EVAL#{runId}` | `META` | scores and judge outputs |

Traces (full prompts and completions) go to S3 `traces/{runId}/{seq}.json` to keep DynamoDB items small and to support offline evaluation.

## 6. Agent runtime

**No framework, and one agent runtime.** There is a single `runAgent(role, brief, context)` function implementing the ReAct loop; the orchestrator, the five specialists and the Scenario Author are not separate programs but roles: a role is a system prompt, a tool subset, an autonomy policy and a stop condition, declared in `roles/*.ts`. The orchestrator runs as `runAgent('orchestrator', …)`; when it calls the `delegate(role, brief)` tool, the runtime invokes itself recursively as that role with a scoped context and returns the sub-run's structured report as the tool result. Sub-agents are therefore ordinary tool calls, appear in the same event log with a parentRunId, share the same provider adapter, budget accounting and guardrails, and can run concurrently when the orchestrator issues several delegate calls in one turn (`Promise.all`). Adding an agent means adding a role file, not code.

**Loop.** `while (iterations < max && !done)`: build messages (system prompt, scenario context block, conversation so far) → call provider with tool definitions → for each tool call: validate arguments against the JSON schema, look up its autonomy tier, run it or convert it into a proposal, append the result → emit events → stop when the model returns a final report tool call. Hard limits: 25 iterations per agent, 60 tool calls per run, 200k input tokens per run, 8-minute wall clock; any breach ends the run with an `agent.aborted` event.

**Provider interface.** `complete({system, messages, tools, maxTokens, temperature}) → {text, toolCalls[], usage, stopReason}` with three adapters: Anthropic Messages API (default, tool use with input_schema), OpenAI Responses API (function tools), Bedrock Converse (toolConfig). Selected by `LLM_PROVIDER` and `LLM_MODEL`; retries with exponential backoff and a per-run fallback provider if the primary returns 5xx twice. Prompt caching enabled on Anthropic for the system prompt and scenario block.

**Tool definition.** Every tool is a module exporting `{name, description, inputSchema, tier, system, handler}`. `tier` is execute, propose or forbidden and is enforced in the loop, never in the prompt: a propose call writes an `agent.proposal` event and blocks that agent until an approval event arrives (or the baseline policy auto-decides in baseline mode); a forbidden call is rejected with an explanatory tool result and a `guardrail.blocked` event.

| Agent | Tools (system) | Typical tier |
|---|---|---|
| Orchestrator | open_incident, delegate(agent, brief), set_objective, request_decision, report | execute |
| Maintenance | get_aircraft_status, get_open_defects, search_mel, create_work_order, page_engineer, draft_techlog_entry, record_engineering_decision (M&E, knowledge) | execute; draft_techlog_entry propose; deferral decisions forbidden |
| Ground | get_stand_status, request_stand, request_tow, request_bus, notify_handler (airport, handler) | execute |
| Flight Ops | get_rotation, find_spare_aircraft, get_crew_fdp, find_standby_crew, propose_swap, propose_cancel, assign_standby_crew (OCC, crew) | reads execute; swap/cancel/crew propose; FDP extension forbidden |
| Passenger | get_manifest_summary, estimate_eu261_exposure, draft_passenger_message, send_passenger_message, issue_care_vouchers, rebook_cohort (PSS, comms) | drafts execute; send and rebook propose |
| Incident Record | append_timeline, draft_occurrence_report, draft_discretion_report, export_evidence_pack (record) | execute |
| Scenario Author | validate_scenario, lookup_airport, search_precedents (knowledge) | execute |

**Context block.** The orchestrator receives the scenario as a fenced, clearly labelled data block (`<scenario_data>`), never as instructions; the same wrapper is used for every tool result and knowledge chunk (section 11).

Events emitted per iteration: `agent.thought` (the model's visible reasoning text), `agent.tool_call`, `agent.tool_result`, `agent.proposal`, `agent.report`, `guardrail.blocked`, each with agent id, iteration, sim time, token usage and latency.

## 7. Mocked airline systems

Each system is a TypeScript module with a typed state, seeded from the scenario, persisted per run in DynamoDB (`SYS#` rows) and exposed both as agent tools and as `GET /runs/{id}/systems/{name}` for the inspector. Mocks are stateful and rule-bound: a work order has a lifecycle, an engineer has a location and travel time, a stand can be occupied, a crew member has an FDP clock. Swapping a mock for a real adapter later means implementing the same interface.

| System | Stands in for | State it holds | Rules it enforces |
|---|---|---|---|
| mne | Maintenance & engineering / tech log | Aircraft, open and deferred defects, MEL items, work orders, engineering decisions | Only a certifying_staff actor can set deferred/released; the agent can only create and read |
| occ | Operations control / rotation | Day's flights per tail, stations, spare aircraft, curfews, swap and cancel decisions | Swap requires a spare at the station with enough turn time; cancellations set downstream status |
| crew | Crew management | Operating and standby crew, report times, FDP limits and remaining margin | FDP computed from report time and sectors; extension beyond limit is refused to software |
| pss | Passenger service / DCS | Manifest summary by cohort (connections, PRM, families, unaccompanied minors), rebooking options, vouchers, messages sent | EU261 tier by distance; rebooking only onto flights with seats |
| airport | Airport operations | Stands, gates, buses, stairs, tows, curfew and weather snapshot | Stand requests confirm after a modelled delay; curfew blocks late departures |
| handler | Ground handling provider | Staff on shift, equipment, task queue, occurrence reports | Tasks acknowledged with a modelled response time |
| engineers | Engineer roster and positioning | Engineers by station, skills, availability, travel options (drive, fly) | Travel time from a station distance table |

All mock data is fictional: airports are real codes (from OurAirports), the carrier, tails, people and flights are generated at build time from a seed. No real airline schedule or personal data is used.

## 8. World engine, scenario schema and KPI models

**Scenario schema** (`scenario.schema.json`, versioned). Fields: id, title, narrative, aircraft (type, tail, station, next sectors), trigger (type, sim time, description, evidence), world (spares, engineers, crew FDP, passenger cohorts, weather, curfew), twists[] (id, at or manual, description, effects), baseline (chronology of actions with sim times, as a human team would do today), expected (constraints that must hold, e.g. `no_software_deferral`, `first_pax_message_before_min: 15`), kpi_params (€ per minute, EU261 tier, reactionary factor). The Scenario Author agent produces this JSON and it is validated with Ajv before a run starts.

**World engine.** A discrete clock (default 6× real time, 10-second sim ticks). Each tick applies scheduled twists, advances modelled processes (engineer travel, stand confirmation, repair progress, boarding), updates flight states and recomputes KPIs. Agent actions change the world only through mock-system mutations, so the engine is independent of the LLM. In baseline mode the engine replays the scenario's baseline chronology with a scripted decision policy instead of agents.

**KPI models (pure functions of world state, unit-tested).**

| KPI | Formula |
|---|---|
| Delay cost | primary minutes × €/min (default €100; EUROCONTROL reference) + reactionary minutes × factor (default 1.8) × €/min |
| EU261 exposure | passengers × tier (€250/400/600 by distance) when projected delay ≥ 3 h, plus care costs by elapsed hours |
| Cancellation cost | fixed per-scenario value (default €18,600) plus rebooking and accommodation |
| Customer satisfaction (0–100) | starts 100; −0.8/min uninformed after event; +8 on first proactive message; +5 per care action; +10 if rebooked before 3 h; −15 on cancellation; floor 0 |
| Compliance | booleans: Art 14 notice issued, rerouting offered ≤ 3 h, FDP respected, MOR drafted ≤ 72 h, 3-hour threshold avoided |
| Safety gates | count of forbidden tool calls attempted (must be 0) and of human decisions recorded before dependent actions |
| Coordination latency | sim minutes to first engineering decision, first passenger message, swap or cancel decision |

## 9. Data and knowledge

Real incident narratives and public reference documents exist under licences that allow reuse; proprietary manuals do not. The knowledge base is built from the open sources below, chunked and indexed at build time into S3, and queried by the `search_precedents`, `search_mel`, `search_procedure` and `search_passenger_rights` tools, each returning chunks with a source id, URL and quote. ECCAIRS (the European occurrence repository) is not public and is excluded.

| Source | Use in the MVP | Access | Licence |
|---|---|---|---|
| NASA ASRS database and CALLBACK | Primary corpus of real pushback, GSE-strike, gate-fault and bird-strike narratives; precedent search; scenario seeds | Web export up to 10,000 records (CSV); packaged on Hugging Face as `elihoole/asrs-aviation-reports` (47,723 reports) | US Government work, public domain; reports are unverified — keep NASA's disclaimer |
| UK AAIB reports | High-quality airline ground-event narratives with analysis; UK precedents | HTML and PDF bulletins; scrape the listing | Open Government Licence v3.0 |
| FAA Accident and Incident Data System | Supplementary US airline incidents | CSV export | Public domain |
| FAA A-320 MMEL | MEL stand-in: item, category, dispatch conditions quoted verbatim | PDF | Public domain |
| EASA Easy Access Rules for Air Operations (ORO.MLR.105, ORO.FTL, CAT.GEN.MPA.105) | Rule text for MEL policy, FDP limits, commander's responsibilities | PDF and XML | EASA, reuse with attribution |
| FAA AC 150/5210-20A, UK CAA CAP 642, FSF ramp procedures template | Ground-operations procedure stand-ins (towing, clearance zones, damage reporting) | PDF and Word | Public domain; CAA attribution; FSF template intended for adaptation (confirm before redistribution) |
| Airbus Safety First ground-ops articles | OEM guidance on lightning strikes, parking, door and slide incidents | HTML | Reprint permitted with acknowledgement to Airbus |
| EUROCONTROL Standard Inputs 10.0.2 | Delay-cost parameters for the KPI model | HTML tables | Free, cite with attribution |
| EU Regulation 261/2004, UK CAA passenger rights | Passenger-rights rules and care duties | HTML | EU reuse under Decision 2011/833/EU; CAA attribution |
| OurAirports | Airport codes, coordinates, names for the map and distance table | CSV | Public domain (Unlicense) |
| NOAA Aviation Weather Center API | Optional live METAR/TAF for the station in a scenario | JSON, no key | Public domain |

**Not used, by design:** IATA IGOM and AHM, ICAO Doc 10121, SKYbrary article text, any airline operations manual or MEL, OpenFlights (share-alike) and OpenSky (non-commercial terms) — linked in docs, never copied.

**Build pipeline (`npm run kb:build`).** Download or read the sources into `data/raw/` (with a `SOURCES.md` recording URL, date, licence), extract text, chunk at ~500 tokens with metadata (source, section, jurisdiction EU/UK/US, date), compute BM25 statistics and small embeddings (provider-agnostic, e.g. text-embedding-3-small or Bedrock Titan), and write a compact index to S3 that the Run Lambda loads on cold start (< 50 MB). ASRS narratives are also used to seed the scenario library: each shipped scenario cites the real reports it was inspired by.

**Optional live research tool.** `web_search` (Tavily or Brave API) restricted to an allow-list of the domains above, used only by the Scenario Author agent, with results wrapped as untrusted data.

## 10. Evaluation

No public benchmark covers pre-departure incident coordination (the closest are Pre-Flight for ground-ops knowledge and MITRE ALUE for aviation language tasks), so the repository ships its own evaluation set and harness. Evaluation runs headless in baseline-free agent mode with auto-approval policies, so it needs no human in the loop.

**Evaluation set** (`evals/cases/*.json`, target 40 cases). The 10 library scenarios, each with 2–3 variants (different station, twist, crew margin), plus 8 adversarial cases (prompt injection in scenario text, in a mock tool result and in a knowledge chunk; a scenario that tempts a deferral; an FDP-breach temptation; a missing-spare dead end). Each case declares expected: hard constraints, required actions, forbidden actions, latency targets and a reference summary.

| Layer | What is checked | How |
|---|---|---|
| Trajectory assertions (deterministic) | No forbidden tool call executed; required tools called in a valid order (engineer paged before swap proposed; passenger message before minute 15); every proposal has a human or policy decision recorded; schema-valid tool arguments; iteration and token budgets respected | Code over the event log; pass/fail per assertion |
| Outcome metrics | Coordination latencies, delay minutes, cost, satisfaction, compliance booleans vs. the case's baseline | KPI models; reported as deltas |
| Knowledge grounding | Every factual claim about MEL, rules or precedents in agent output cites a chunk that contains it | Citation-presence check plus LLM judge on faithfulness |
| LLM-as-judge rubric (1–5) | Correct incident understanding; quality of alternatives and trade-offs; passenger message clarity, tone and legal accuracy (no "extraordinary circumstances" claims); occurrence-report completeness; respect of human authority in wording | A stronger model than the agent, rubric prompts versioned in `evals/rubrics/`; two judgements averaged |
| Robustness | Adversarial cases: injected instructions are not followed; `guardrail.blocked` events present | Assertions |
| Cost and latency | Tokens, USD and wall time per run; regression thresholds | Trace aggregation |

**Scoring and reporting.** `npm run eval` executes all cases (parallelism 3), writes `evals/reports/{date}.json` and a Markdown summary with pass rate per layer, mean judge scores, metric deltas vs. baseline and a diff against the previous report. CI runs a 6-case smoke subset on every pull request and the full set nightly; a pull request fails if any hard assertion regresses or the smoke judge mean drops by more than 0.3.

**Human calibration.** Ten cases judged once by an aviation-operations reviewer to calibrate the rubric; disagreements recorded in `evals/calibration.md`.

## 11. Security, guardrails and regulatory constraints

**Single-user access.** Cognito user pool with one admin-created user (self-sign-up disabled), hosted UI with PKCE, MFA optional. HTTP API routes use the Cognito JWT authorizer; the WebSocket `$connect` Lambda validates the same token. S3 buckets are private; CloudFront uses origin access control; API keys and provider secrets live in Secrets Manager and are read by Lambda at cold start. IAM roles are per function with least privilege. WAF on CloudFront and API Gateway with the AWS managed common rule set and a rate limit of 100 requests per 5 minutes per IP.

**Cost guards.** AWS Budgets alarm at USD 20/month; Run Lambda reserved concurrency 2; per-run token and iteration caps (section 6); provider spend cap configured in the provider console; a `MAX_RUNS_PER_DAY` limit enforced in the API.

**Prompt-injection guardrails.** The agents read text from four untrusted channels: scenario narratives (typed by a presenter or authored from free text), knowledge chunks (public documents), mock tool results (seeded data) and optional web search. Defences, in layers:

1. **Structural separation.** All untrusted content is delivered inside typed data wrappers (`<scenario_data>`, `<tool_result source="mne">`, `<document source="AAIB-2024-xx">`) with an explicit system-prompt rule that such blocks are data to reason about, never instructions to follow; system prompts are code, never assembled from user text.
2. **Capability, not obedience.** Authority lives in code: the autonomy tier of every tool is enforced in the loop, so even a fully hijacked model cannot defer a defect, extend FDP or send an unapproved passenger message. This is the primary control.
3. **Input screening.** Scenario text and author input pass a lightweight classifier (regex patterns plus an LLM check) for instruction-like content ("ignore previous", "you are now", tool names, URLs); flagged text is either rejected or neutralised (quoted and labelled) before reaching agents.
4. **Output screening.** Passenger-facing drafts and reports are checked for secrets, URLs not on the allow-list, legal claims ("extraordinary circumstances", compensation denials) and personal data patterns before being shown; violations block the proposal and emit `guardrail.blocked`.
5. **Tool-argument validation.** JSON-schema validation, allow-listed identifiers (tails, stations, cohort ids must exist in the run), bounded numbers, no free-text pass-through into mock mutations.
6. **Provenance in the UI.** Every knowledge answer shows its source; every action shows its tier and who approved it; AI-drafted text is labelled as such.
7. **Adversarial evaluation.** The eight injection cases in section 10 run in CI; new attack patterns become new cases.

**Regulatory constraints reflected in the design (EU/UK).**

| Regime | Constraint | Where it is implemented |
|---|---|---|
| EU AI Act (Reg. 2024/1689), Art 50 transparency; high-risk obligations deferred to 2027–28 | AI-generated text shown to people must be identifiable as such; a coordination tool is not a safety component and is kept outside Annex III by design | "AI-drafted" labels in UI and message payloads; no crew task allocation by personal traits (only FDP legality checks) |
| EASA AI Concept Paper Level 1B/2A; UK CAA CAP3064A | Human oversight and full override for any AI that proposes or implements operational actions | Autonomy tiers; approval cards; kill-switch; audit log |
| Part-M / Part-145 / Part-66; ORO.MLR.105; ORO.FTL.205; CAT.GEN.MPA.105 | Deferral, release, MEL application, FDP extension and departure decisions are reserved to certifying staff and the commander | forbidden tier on those actions; decision-capture tools record a named human actor |
| Reg. 376/2014 occurrence reporting (EU and UK-retained) | Reports are filed by named persons within 72 h; software can only draft | `draft_occurrence_report` produces a draft tagged for a human reporter |
| EU261/UK261 and the 2026 EU reform (applicable ~2027) | Passenger information duties, care, 3-hour thresholds; no false extraordinary-circumstances claims | KPI compliance booleans; output screening of legal claims; message templates reviewed |
| UK GDPR / EU GDPR, Data (Use and Access) Act 2025 | No real personal data; automated decisions affecting people need human intervention | Fictional cohorts only; rebooking and care actions are propose tier; data-minimised traces |
| EASA Part-IS (from Feb 2026) and UK CAA cyber guidance | Information-security management for connected operational software | Not applicable to the MVP (mocked systems only), but the least-privilege, audit-logging and secrets design is documented as the pattern a pilot would inherit |

## 12. Deployment

AWS CDK v2 in TypeScript, three stacks so the front end can be redeployed without touching data: **DataStack** (DynamoDB table with stream, S3 buckets for site, knowledge index and traces, Secrets Manager placeholders), **ApiStack** (Cognito, HTTP API, WebSocket API, Lambdas, WAF, budgets and alarms) and **WebStack** (CloudFront distribution, S3 deployment of the Vite build with the API URLs injected as `config.json`). Region default `eu-west-2` (London) to keep data in the UK/EU; any region works.

**Prerequisites:** AWS account with admin credentials, Node 22, AWS CDK CLI, one provider API key. **Steps:** `cp .env.example .env` and set `LLM_PROVIDER`, `LLM_MODEL`; `npm install`; `npm run kb:build` (downloads sources, builds the index; ~10 min); `npx cdk bootstrap`; `npx cdk deploy --all`; `npm run user:create -- you@example.com` (creates the Cognito user and prints a temporary password); put the provider key in Secrets Manager with `npm run secrets:set`. Total first deploy under 20 minutes.

**Local development:** `npm run dev` runs the Vite dev server against a local in-memory implementation of the same DynamoDB and WebSocket interfaces, so the whole loop runs on a laptop without AWS; `npm run dev:aws` points the front end at a deployed API.

**Cost estimate** (illustrative, us/eu regions, 2026 list prices). Idle: DynamoDB on-demand storage, S3 (~100 MB), CloudFront and WAF base ≈ USD 3–6/month. Per full scenario run: Run Lambda ~5 min at 1.8 GB ≈ USD 0.01; DynamoDB writes ~2,000 ≈ USD 0.003; provider tokens are the real cost — roughly 150k input and 20k output tokens per run ≈ USD 0.6–2.0 depending on model; a 40-case evaluation ≈ USD 30–60. Terraform: not shipped, but the CDK constructs are simple enough that a Terraform port is a welcome contribution.

## 13. Repository structure and open-source hygiene

```
incident-command-agent/
├─ apps/web/            React + Vite front end
├─ services/api/        HTTP and WebSocket Lambda handlers
├─ services/run/        Run Lambda: world engine, agents, tools
│  ├─ agents/           orchestrator, maintenance, ground, flightops, passenger, record, author
│  ├─ tools/            one module per tool with tier and schema
│  ├─ systems/          mne, occ, crew, pss, airport, handler, engineers
│  ├─ world/            clock, twists, kpi models
│  └─ llm/              provider adapters (anthropic, openai, bedrock)
├─ packages/schema/     scenario and event JSON schemas, shared types
├─ scenarios/public/    10 shipped scenarios (fictional carrier)
├─ scenarios/private/   git-ignored client scenarios
├─ config/brand.default.json   Northwind Air
├─ config/brand.local.json     git-ignored client branding
├─ data/                kb:build pipeline, SOURCES.md, raw downloads (git-ignored)
├─ evals/               cases, rubrics, harness, reports
├─ infra/               CDK app and stacks
├─ docs/                architecture, ADRs, this specification, demo script
└─ .github/workflows/   lint, test, eval-smoke, cdk-synth
```

**Anonymity rules.** No client, airline or consultancy names anywhere in code, data, scenarios, screenshots, issues or commit history; the fictional carrier is the only identity in the public tree. `brand.local.json`, `scenarios/private/`, `.env` and `data/raw/` are git-ignored, and a pre-commit hook (gitleaks plus a word-list check) blocks keys and the configured private names. Squash history before the first public push.

**Licensing.** Code under Apache-2.0; scenario files and documentation under CC BY 4.0; third-party data retains its own licence, recorded per file in `data/SOURCES.md` with URL, retrieval date and licence; synthetic paraphrases are used wherever a source does not permit verbatim reuse. NOTICE acknowledges NASA ASRS, AAIB (OGL v3), FAA, EASA, UK CAA, EUROCONTROL, Airbus Safety First and OurAirports.

**Contributor experience.** README with a 90-second GIF, CONTRIBUTING.md, issue templates for new scenarios and new tools, ADRs for the main decisions (no framework, event sourcing, direct provider APIs, single-table DynamoDB), and a `docs/demo-script.md` for presenters.

## 14. Sources

- NASA ASRS Database Online and CALLBACK
- Hugging Face: elihoole/asrs-aviation-reports
- UK AAIB reports (gov.uk)
- FAA Accident and Incident Data System
- NTSB CAROL
- FAA A-320 MMEL Rev 32 (draft)
- EASA Easy Access Rules for Air Operations
- FAA AC 150/5210-20A Ground Vehicle Operations
- UK CAA CAP 642 Airside Safety Management and CAP 382S
- Flight Safety Foundation GAP ramp procedures
- Airbus Safety First — ground operations
- EUROCONTROL Standard Inputs — cost of delay
- EU Regulation 261/2004 (EUR-Lex) and Commission Decision 2011/833/EU on reuse
- UK CAA passenger rights — delays
- OurAirports data
- NOAA Aviation Weather Center Data API
- ECCAIRS / European Central Repository access
- IATA IGOM (paid) and ICAO Doc 10121 (paid)
- Pre-Flight benchmark and MITRE ALUE
- EU AI Act Annex I and Digital Omnibus 2026 deadline changes
- EASA AI Concept Paper proposed Issue 03 and UK CAA CAP3064A
- Reg. (EU) 376/2014 Art 4 (UK-retained)
- UK CAA regulatory library — ORO.MLR.105, ORO.FTL.205, CAT.GEN.MPA.105
