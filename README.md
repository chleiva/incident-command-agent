# Incident Coordination Agent

**Agentic incident coordination for airline operations — LLM agents coordinate the response; people keep the authority, enforced in code.**

[![ci](https://github.com/chleiva/incident-command-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/chleiva/incident-command-agent/actions/workflows/ci.yml)
[![cdk-synth](https://github.com/chleiva/incident-command-agent/actions/workflows/cdk-synth.yml/badge.svg)](https://github.com/chleiva/incident-command-agent/actions/workflows/cdk-synth.yml)
[![Licence: Apache-2.0](https://img.shields.io/badge/licence-Apache--2.0-blue.svg)](LICENSE)
[![Systems: simulated](https://img.shields.io/badge/systems-simulated-orange.svg)](#disclaimer)

![A duty manager picks a boarding flight on the live network map, reports pushback damage, and watches the cockpit and the Agents view fill in as six agents work in parallel; a decision card asks for approval of the first passenger message, and the approval appears as a row signed by the Duty Manager.](docs/media/hero.gif)

<sub>Recorded in mock mode: fictional carrier (Accent Air), simulated airline systems, recorded agent runs. [MP4 version](docs/media/hero.mp4).</sub>

- **One hand-written agent loop, seven roles.** An orchestrator, five specialists (maintenance, ground, flight operations, passengers, incident record) and a scenario author, all running the same ReAct loop; a role is data, not code.
- **53 tools, 6 of them forbidden to software.** 36 run at once, 11 wait for a person, and deferral, release, duty extension and three flight-deck decisions are blocked by the runtime whatever the prompt says.
- **Every step is an event.** 31 event types in one log; the cockpit, the evals and time travel are all folds of it with one pure reducer.

## Contents

- [What it is](#what-it-is)
- [Why it's hard](#why-its-hard)
- [Screenshots](#screenshots)
- [How the agents work](#how-the-agents-work)
- [Safety by design](#safety-by-design)
- [Knowledge and citations](#knowledge-and-citations)
- [Evaluation](#evaluation)
- [Try it in 60 seconds](#try-it-in-60-seconds)
- [Deploy your own](#deploy-your-own)
- [Repository map](#repository-map)
- [Documentation](#documentation)
- [Contributing](#contributing)
- [Licences](#licences)
- [Disclaimer](#disclaimer)
- [Acknowledgements](#acknowledgements)

## What it is

An open-source, serverless system on AWS in which LLM agents coordinate the response to an airline incident (pushback damage, a lightning strike at an outstation, a bird strike on the climb, a medical diversion) across stateful, simulated airline systems: maintenance, operations control, crew, passenger service, airport, ground handling and engineers. A duty manager reports an incident on any flight of the fictional carrier's day; the agents gather facts, page engineers, draft messages and rank options, and every action that touches people or the aircraft waits for a named human or is refused outright. A React cockpit shows every effect live, a paired baseline replays how a manual team would handle the same incident, and an evaluation harness scores the agents.

## Why it's hard

- **Many teams, one clock.** Engineering, ramp, crew, passengers and the incident record all move at once, and each depends on the others' facts.
- **Authority is split, and not up for negotiation.** Certifying staff release aircraft, the commander decides the flight, the duty manager decides the plan. A persuasive model must not be able to cross those lines.
- **The facts change under you.** An engineer's arrival slips by 40 minutes and a decision approved ten minutes ago is now wrong.
- **Everything must be explainable afterwards.** Regulators, passengers and the next shift need to know who decided what, when, and on what evidence.

## Screenshots

<table>
  <tr>
    <td width="50%"><img src="docs/media/network.png" alt="The live network map: Accent Air's fictional day of 80 flights over real European airports, with a boarding Manchester departure selected and its passengers, crew duty and aircraft rotation in the side panel."></td>
    <td width="50%"><img src="docs/media/cockpit-options.png" alt="The cockpit during a lightning-strike incident at Faro: KPI tiles, network, ground, passengers and timeline zones, and a decision card asking the duty manager to choose between contracting a local engineer, flying one in, ferrying a spare aircraft or cancelling."></td>
  </tr>
  <tr>
    <td><b>Network.</b> A fictional day schedule on the real UTC clock, computed in the browser. Pick any flight and report an incident.</td>
    <td><b>Cockpit.</b> Six KPI tiles, seven zones and the decision card. Choosing an option is the decision; each action it leads to is approved on its own.</td>
  </tr>
  <tr>
    <td><img src="docs/media/agents.png" alt="The Agents view: one column per agent with every brief, tool call, proposal, wait and decision as a row, including a blocked attempt to extend a crew duty period and an approval withdrawn because the engineer's ETA changed from minute 38 to minute 78."></td>
    <td><img src="docs/media/audit.png" alt="The Audit view: an LLM call expanded to show the exact context sent to the model (system prompt, tool definitions, wrapped scenario data) next to the model's output and tool calls."></td>
  </tr>
  <tr>
    <td><b>Agents view.</b> One column per agent, one row per action: briefs, tool calls, proposals, waits, decisions, blocks and withdrawals.</td>
    <td><b>Audit.</b> Every model call as sent and as returned, and every tool call's input and output. API keys are redacted.</td>
  </tr>
</table>

## How the agents work

```mermaid
flowchart LR
  DM(["Duty manager"]) -->|"reports an incident on a flight"| ORCH
  subgraph RUN["Run Lambda: one runAgent loop"]
    ORCH["Orchestrator"] -->|"delegate (parallel)"| MX["Maintenance"]
    ORCH --> GR["Ground"]
    ORCH --> FO["Flight operations"]
    ORCH --> PX["Passengers"]
    ORCH --> RC["Incident record"]
  end
  MX & GR & FO & PX & RC -->|"tool call"| GATE{"Tier gate<br/>(code, not prompt)"}
  ORCH -->|"request_decision"| GATE
  GATE -->|"execute"| SYS[("Simulated airline systems<br/>M&E, OCC, crew, PSS, airport,<br/>handler, engineers, record")]
  GATE -->|"propose"| CARD["Decision card"]
  CARD -->|"approve / edit / reject"| DM
  GATE -->|"forbidden"| BLOCK["Blocked and counted;<br/>authority named"]
  SYS --> LOG[("Event log<br/>gap-free seq")]
  CARD --> LOG
  BLOCK --> LOG
  WORLD["World engine<br/>clock, twists, KPIs"] --> LOG
  LOG -->|"stream, WebSocket"| UI["Cockpit, Agents view, Audit<br/>applyEvent projection"]
```

### From a flight to an incident

![An airborne flight is selected on the map; its panel notes that diversion airports are options for the commander's consideration only; the incident dialog lists only airborne incident types, and Start opens the cockpit with the aircraft flying to its arrival station.](docs/media/flight-to-incident.gif)

The incident list depends on the flight's phase and station (a pushback incident needs a boarding flight at a base; a diversion needs an aircraft in the air). The scenario is built from that flight's real context: passengers, crew duty, rotation, spares and engineers.

### One loop, roles as data

There is no agent framework ([ADR 0001](docs/adr/0001-no-agent-framework.md)). `runAgent(role, brief, ctx)` in `services/run/runtime` is the whole loop; each role is a `RoleDefinition` (a constant system prompt, a tool subset, a report schema, a stop condition) in `services/run/agents`. Loop safety is per agent: 25 iterations and 60 tool calls.

### Delegation: parallel specialists

`delegate` is an ordinary tool call that recurses into the same loop, so the orchestrator briefs maintenance, ground, flight operations, passengers and the incident record at once and they run concurrently. A specialist that needs a decision blocks on it; the others keep working. When facts change, the orchestrator re-briefs only the agent that owns the affected work.

### Autonomy tiers, enforced in code

![A presenter asks the maintenance agent to defer a defect through the command palette; a card appears saying "Blocked by autonomy policy", naming the rule (Part-145 / ORO.MLR.105) and who decides (certifying staff), and noting that nothing was changed.](docs/media/blocked-by-design.gif)

Every tool has a tier and the runtime, not the model, applies it. A forbidden call is refused before it reaches a system, recorded as an event and counted on the Safety gates tile. **Demonstrate blocked action** (⌘K) pushes a synthetic forbidden call through the same gate.

| Tier | What the runtime does | Tools (48 domain tools + 5 runtime tools) |
|---|---|---|
| `execute` (32 + 4 runtime) | Runs at once against the simulated system; logged with its state changes | `get_aircraft_status`, `search_mel`, `page_engineer`, `create_work_order`, `request_tow`, `find_spare_aircraft`, `get_crew_fdp`, `estimate_eu261_exposure`, `draft_passenger_message`, `draft_occurrence_report`, `rank_diversion_airports` (options only), `notify_destination_station`…; runtime: `open_incident`, `set_objective`, `delegate`, `report` |
| `propose` (10 + `request_decision`) | The agent blocks; a decision card waits for a person to approve, edit or reject | `send_passenger_message`, `rebook_cohort`, `issue_care_vouchers`, `propose_swap`, `propose_cancel`, `assign_standby_crew`, `record_engineering_decision`, `draft_techlog_entry`, `prepare_diversion_handling`, `arrange_arrival_services` |
| `forbidden` (6) | Never runs. Blocked, counted, and the holder of the authority is named | `defer_defect`, `release_aircraft` (certifying staff); `extend_crew_fdp` (aircraft commander); **flight deck, commander only:** `instruct_flight_crew`, `select_diversion_airport`, `approve_overweight_landing` |

### Approvals, scope and invalidation

![A decision card from the passengers agent lists what approving authorises (sending this exact message, once, to the listed cohorts) and what it does not (any later update, rebooking, care or compensation); the duty manager approves and a green "Approved by Duty Manager" row appears in the passengers column.](docs/media/human-authority.gif)

Each card says exactly what approving authorises and what it does not, so an approval can never be read as a blank cheque. Decisions are recorded with the approver's name and role. A card left alone for 60 seconds is approved in the signed-in person's name and recorded as their *implicit* approval ("no objection within 60 s"), the way a duty manager's standing approval works; it can be switched off, and airworthiness decisions always need an explicit decision from certifying staff.

![The engineer's arrival slips by 40 minutes; in the passengers column an amber row reads "Approval withdrawn: engineer ETA changed (m38 → m78)", the orchestrator re-briefs the passengers agent, and a revised passenger message is proposed and approved.](docs/media/assumption-changed.gif)

An approval records the facts it relied on. When the world changes one of them (here, the engineer's ETA), the approval is withdrawn with the old and new values, the owning agent re-gathers the evidence, and a revised proposal, linked to the withdrawn one, goes back to a person.

### Self-recovery: retry, containment, resume

- **Retry.** Transient AWS errors are retried everywhere in the run path (5 attempts, full jitter, 8 s cap). LLM calls retry with backoff and switch to a configured fallback model after repeated provider errors.
- **Containment.** A failure is contained at the smallest scope: a failed tool call becomes an error result for the agent; a failed agent is aborted and the orchestrator re-briefs; a failed world process is skipped.
- **Resume.** Only an unwritable event log ends a run, and then the run resumes itself (at most twice) by re-invoking the Run Lambda and rebuilding its state from the log. The cockpit shows failed, stopped and recovering runs calmly and truthfully.
- **Continuation.** A Lambda runs for at most 15 minutes, and a human-paced run often lasts longer. It then carries on in a fresh invocation with pending approvals, the clock and the speed kept (up to 12 times, about 3 hours of real time). A continuation is not an error and does not use the resume allowance.

### Time travel and event sourcing

![In the Agents view the timeline is dragged back from the end of a run: later rows disappear and each column counts the actions after the viewed moment; the dashboard, opened at the same moment, shows the KPIs and zones as they were, then returns to live.](docs/media/time-travel.gif)

Each agent step, tool call, world tick, KPI update, mutation and approval is an event row, written in one DynamoDB transaction with the state rows it changes, under a gap-free sequence number ([ADR 0002](docs/adr/0002-event-sourcing.md)). The browser applies the same `applyEvent` reducer as the API and the evals, so a refresh replays the run exactly and the scrubber rebuilds any moment.

### Full audit

![The Audit view: a recorded run is picked, an LLM call is expanded to show the context sent to the model and its output, and the output is switched to raw JSON.](docs/media/audit.gif)

Every LLM call is stored as a trace: model, parameters, the full context (system prompt, tool definitions, wrapped data) and the raw response. Every tool call shows its input, output, tier and approver. A run's audit exports as JSON Lines, and the cockpit exports an evidence pack (PDF) with decisions, approvers, AI-drafted texts and citations.

## Safety by design

**Authority lives in code, not prompts.** The tier gate in `services/run/runtime` decides what runs. Deferral, release, duty extension and departure are human decisions; in the air the commander flies and decides the aircraft, and the agents only rank airports as options and prepare the ground. Rebooking, care, passenger messages, swaps and cancellations wait for a person. The autonomy matrix changes only deliberately, and the evals change with it.

**Untrusted content is data, in layers.**

1. System prompts are constant strings; scenario, user and tool text is never interpolated into them.
2. Scenario text, tool results, knowledge chunks and free-text twists are wrapped (`<scenario_data>`, `<tool_result>`, `<document>`, `<twist_data>`) under a data-handling preamble, with wrapper tags escaped inside the content.
3. Free text is screened on the way in (heuristics, plus an optional LLM classifier with `SCREEN_WITH_LLM=true`) and neutralised or rejected.
4. Tool arguments are validated against JSON Schema, and every referenced id must exist in the run.
5. Passenger-facing texts and reports are screened on the way out: unsupported status claims, legal claims and links outside an allowlist.
6. Whatever gets through still meets the tier gate. Ten adversarial eval cases (prompt injection in scenarios, twists, tool results and authoring, pressure to pick a diversion airport or instruct the crew) keep it that way.

**Regulatory constraints reflected in the design (EU/UK).**

| Regime | Constraint | Where it is enforced |
|---|---|---|
| EU AI Act (Reg. 2024/1689), Art 50 transparency | AI-generated text shown to people must be identifiable | `aiDrafted: true` is a schema literal on every drafted message and report; the UI labels each one "AI-drafted" |
| EASA AI Concept Paper, Level 1B/2A (human oversight) | Full human oversight and override of AI that proposes or implements operational actions | Autonomy tiers, decision cards, the kill switch (stop) and the audit log |
| Part-145 / ORO.MLR.105; 145.A.50 | Deferral under the MEL and release to service belong to certifying staff | `defer_defect` and `release_aircraft` are `forbidden`; `record_engineering_decision` records a named certifying engineer |
| ORO.FTL.205; CAT.GEN.MPA.105 | Extending a flight duty period is the commander's discretion; the commander decides the flight | `extend_crew_fdp`, `instruct_flight_crew`, `select_diversion_airport`, `approve_overweight_landing` are `forbidden`; a KPI checks commander authority was respected |
| Reg. (EU) 376/2014 occurrence reporting | Reports are filed by named persons within 72 h; software may only draft | The incident-record agent's `draft_occurrence_report` produces a draft for a human reporter; the compliance KPI tracks "MOR drafted ≤ 72 h" |
| Reg. (EC) 261/2004 (and UK261) | Information duties, care, the 3-hour threshold, no false extraordinary-circumstances claims | `estimate_eu261_exposure`, `search_passenger_rights`, care vouchers as `propose`, compliance KPIs and output screening of legal claims |

The design rationale, including GDPR and cyber-security notes, is in [the specification, §11](docs/specification.md).

## Knowledge and citations

Every knowledge claim an agent makes carries a citation (source id and verbatim quote). The corpus is built from open data only by `npm run kb:build`; no airline manuals, OEM documents or IATA/ICAO text. Counts are from the build recorded in [`data/SOURCES.md`](data/SOURCES.md) (retrieval date 2026-09-26).

| Collection | Sources | Licence | Chunks |
|---|---|---|---|
| `precedent` | NASA ASRS (15,000 reports kept of 47,723 scanned); UK AAIB reports (up to 150) | Public domain; Open Government Licence v3.0 | 17,788 |
| `mel` | FAA A-320 MMEL, Rev 32 (draft) | Public domain | 547 |
| `procedure` | UK CAA CAP 642; FAA AC 150/5210-20A; Airbus Safety First ground-operations articles | © UK CAA, with attribution; public domain; reprinted with acknowledgement to Airbus | 355 |
| `rules` | EASA Easy Access Rules for Air Operations (ORO.MLR.105, ORO.FTL, CAT.GEN.MPA.105, with AMC and GM) | © European Union, reuse with acknowledgement | 129 |
| `passenger_rights` | Reg. (EC) 261/2004; UK CAA passenger-rights pages | © European Union (Decision 2011/833/EU); © UK CAA, with attribution | 40 |
| Parameters | EUROCONTROL Standard Inputs (cost of delay); OurAirports (stations) | Free with attribution; public domain | — |

Chunking follows each collection's structure (one MEL item, one rule sub-paragraph or AMC/GM element, one EU 261 article, heading-aware procedure sections, one report up to ~1k tokens), with a deterministic context header on every chunk.

**Hybrid retrieval, degrading gracefully** (`services/run/knowledge`):

1. BM25 over the chunks, in memory, and a **Cohere Embed v4** query embedding (Amazon Bedrock, EU cross-region profile) against **Amazon S3 Vectors** (top 50, filtered by collection and jurisdiction).
2. Reciprocal rank fusion, then several chunks of one document collapse into one hit.
3. **Selective Cohere Rerank 3.5** over the top 30: skipped when BM25 and the vector search agree on the top document, reused from cache for repeated queries, and rate-limited by a token bucket that never waits.
4. Any embedding, vector or rerank error or timeout falls back a stage (fused without rerank, then BM25 only). It is logged and never fails a run.

Locally the same code searches a MiniLM or BM25-only index with no AWS; tests use a committed 34-chunk fixture index.

## Evaluation

The harness (`evals/`) runs scenarios end to end and scores six layers:

| Layer | Checks |
|---|---|
| Trajectory | Valid events; the required tools were called; nothing forbidden or human-only executed; every proposal decided; key latencies (first passenger message, engineer paged, decision); no legal claims sent; the run ends with a report |
| Outcome | KPI deltas against the paired baseline run of the same incident |
| Grounding | Knowledge claims carry citations, and every cited chunk was actually retrieved in that run |
| Judge | An LLM judge (two judgements averaged, over a compact run digest) scores understanding, alternatives and respect for human authority |
| Robustness | Injected instructions are not followed, canaries are not echoed, guardrails block what they should |
| Cost | Tokens and USD per case, within the case's run budget |

**48 cases**: 37 scenario cases across all 15 scenarios, 10 adversarial cases and 1 runtime fixture. Tiers: `replay` and `baseline` are free and run in CI; `smoke` (6), `core` (14) and `full` (47) are live.

**The lifetime cap is £10, ever** ([ADR 0006](docs/adr/0006-eval-budget-guard.md)). It is a constant in code that configuration can lower but not raise, with a committed append-only ledger, reserve-then-settle accounting with a 1.10 safety margin, a pre-flight worst-case check and interactive confirmation. **Record once, replay forever:** live spend only records traces and judge verdicts; every later run replays them at £0. There are no live evals in CI.

```bash
npm run eval                            # replay tier: free, deterministic (what CI runs)
npm run eval -- --tier baseline         # the scripted human-baseline policy on every case: free
npm run eval:budget                     # the ledger and the remaining lifetime budget
npm run eval -- --tier smoke --live     # live: asks for confirmation and draws on the £10 cap
```

## Try it in 60 seconds

Needs Node.js ≥ 22.12. No API keys, no AWS account.

```bash
npm install
npm run dev:mock        # → http://localhost:5173
```

Mock mode runs the whole app against an in-browser fake backend that replays recorded runs (fictional data, no network). **Report incident** works on any flight: a recorded response (a base, an outstation or an airborne turnback) replays with its identifiers moved onto that flight. The **Training scenarios** page lists all 15 scenarios; the pushback (s01), outstation lightning strike (s04) and air turnback (s11) have full recordings. URL options: `?at=HH:MM` starts the network clock at a time of day, `?autopilot=1` takes every decision hands-free, `?timescale=4` speeds up the replay.

To run the real agent runtime on your machine (in-memory store, API and WebSocket on :8787, the app on :5173, no sign-in):

```bash
cp .env.example .env    # add ANTHROPIC_API_KEY (or another provider) for agent runs
npm run dev             # → http://localhost:5173
```

Without a key the network map and scenario library still load, but agent runs need one. Headless: `npm run run:local -- --scenario s01-pushback-tug-contact --model claude-haiku-4-5`.

## Deploy your own

Prerequisites: an AWS account with administrator credentials for the first deploy, Node.js ≥ 22.12, one LLM provider key (Anthropic by default; OpenAI, or Bedrock model access), and a globally unique Cognito hosted-UI prefix. The CDK CLI comes with `npm install`; Docker is not needed.

```bash
npm install
cp .env.example .env                     # set LLM_PROVIDER, LLM_MODEL, AWS_REGION, COGNITO_DOMAIN_PREFIX
KB_EMBEDDINGS=cohere npm run kb:build    # build the knowledge index from open data (one-off, ≈ USD 1.1 of embeddings)
npm run deploy                           # web build, cdk bootstrap, cdk deploy --all, kb:upload
npm run user:create -- you@example.org   # prints a temporary password
npm run secrets:set                      # hidden prompt; stores the provider key in Secrets Manager
```

`npm run deploy` prints the site URL when it finishes; sign in with the temporary password. `npm run synth` synthesises every stack with cdk-nag checks and makes no AWS calls. Full steps, the stacks, the security model, teardown and troubleshooting are in [docs/deploy.md](docs/deploy.md).

**Cost.** Everything is serverless and pay-per-request. The default deploy idles at about USD 0.40 a month (one secret) plus cents of storage; WAF, alarms and budgets are opt-in. Each knowledge query costs about USD 0.002. LLM tokens are the real cost (roughly USD 0.6–2 per full run) and the product sets no spend limit of its own, so set one in your provider's console.

## Repository map

| Path | Package | What |
|---|---|---|
| [`apps/web`](apps/web) | `@ica/web` | React 18 + Vite cockpit, mock backend, Storybook, Playwright tests and the media scripts |
| [`services/run`](services/run) | `@ica/run` | Run Lambda: agent loop, roles, tools, simulated systems, world engine, guardrails, knowledge |
| [`services/api`](services/api) | `@ica/api` | HTTP and WebSocket API, stream fan-out, local dev server |
| [`packages/schema`](packages/schema) | `@ica/schema` | Types, JSON Schemas, validators, the `applyEvent` reducer, fixtures |
| [`packages/store`](packages/store) | `@ica/store` | Persistence: memory, DynamoDB, S3, Secrets Manager; retry policy |
| [`packages/network`](packages/network) | `@ica/network` | The fictional day schedule, flight state, diversion options, flight-to-scenario templates |
| [`packages/ui-tokens`](packages/ui-tokens) | `@ica/ui-tokens` | Design tokens (light and dark), Tailwind preset, Tokens Studio JSON |
| [`scenarios`](scenarios) | `@ica/scenarios` | 15 shipped scenarios: 10 ground and pre-departure, 5 airborne (CC BY 4.0) |
| [`data`](data) | `@ica/kb` | Knowledge-base build from open data, stations, sources and licences |
| [`evals`](evals) | `@ica/evals` | Cases, rubrics, harness, recorded traces, reports and the lifetime ledger |
| [`infra`](infra) | `@ica/infra` | AWS CDK v2 stacks |
| [`config`](config) | | Brand pack defaults and model pricing |
| [`docs`](docs) | | Specification, architecture, ADRs, deployment, demo script |

## Documentation

- [Specification](docs/specification.md) · [Architecture](docs/architecture.md) · [Deployment](docs/deploy.md) · [Demo script](docs/demo-script.md)
- [Shared contracts](packages/schema/CONTRACTS.md) · [Data sources and licences](data/SOURCES.md)
- Architecture decision records: [0001 No agent framework](docs/adr/0001-no-agent-framework.md) · [0002 Event sourcing](docs/adr/0002-event-sourcing.md) · [0003 Direct provider APIs](docs/adr/0003-direct-provider-apis.md) · [0004 Single-table DynamoDB](docs/adr/0004-single-table-dynamodb.md) · [0005 npm workspaces](docs/adr/0005-npm-workspaces-ts-source-packages.md) · [0006 Eval budget guard](docs/adr/0006-eval-budget-guard.md) · [0007 Product name](docs/adr/0007-product-name.md)

The GIFs and screenshots above are reproducible from mock mode: `npm run gifs` and `npm run screenshots` (Playwright and ffmpeg; they start their own mock server and write to [`docs/media`](docs/media)).

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first: the fictional carrier is the only identity in the tree, authority stays in code, untrusted text stays data, and `npm test` makes no live LLM calls. Before a pull request: `npm run typecheck && npm run lint && npm test`.

## Licences

- Code: [Apache-2.0](LICENSE).
- Scenarios and documentation: [CC BY 4.0](LICENSE-content).
- Third-party data keeps its own licence (public domain, Open Government Licence v3.0, reuse with attribution): see [NOTICE](NOTICE) and [data/SOURCES.md](data/SOURCES.md).

## Disclaimer

Accent Air (`ACX` flights, `AX-XXX` tails) is fictional, and so are every flight, aircraft and person in this repository; the airports are real. All airline systems are simulated. This is a research and demonstration project: it is not certified, not approved by any authority and **not for operational use**. Nothing here is operational, engineering or legal guidance.

## Acknowledgements

The knowledge base stands on open data from NASA's Aviation Safety Reporting System (ASRS), the UK Air Accidents Investigation Branch (AAIB), the US Federal Aviation Administration (FAA), the European Union Aviation Safety Agency (EASA), the UK Civil Aviation Authority (CAA), EUROCONTROL, Airbus Safety First and OurAirports. ASRS reports are submitted voluntarily and are not verified by NASA; they must not be used to infer the frequency of any event.

---

Built by [Chris Beltran](https://www.linkedin.com/in/chris-ai/)
