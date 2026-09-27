# Shared contracts (`@ica/schema`, `@ica/store`)

This is the human-readable reference for the contracts every task builds against. The code is the source of truth:
TypeBox schemas in `packages/schema/src/*.ts` produce both the TypeScript types (`Static<>`) and the JSON Schemas
validated with Ajv (2020-12 + formats).

**Change policy.** Frozen after task 01. During the parallel phase (tasks 02–05) changes must be **additive** (new
optional fields, new event types, new exports) and listed in your final report under "Contract changes". Breaking
changes are reconciled only in the integration pass. When you add something, add a line to
[§11 Additions log](#11-additions-log).

```ts
import { validateScenario, applyEvent, type RunEvent, type ToolDefinition } from '@ica/schema';
import { MemoryStore, DynamoStore, type Store } from '@ica/store';
```

Packages are consumed as TypeScript source (no build). JSON fixtures: `@ica/schema/fixtures/scenario.minimal.json`,
`@ica/schema/fixtures/run.sample.events.json` (import with `with { type: 'json' }`).

---

## 1. Identifiers (`src/ids.ts`)

| Export | Values |
|---|---|
| `AgentRole` / `AGENT_ROLES` | `orchestrator, maintenance, ground, flightops, passenger, record, author` |
| `SPECIALIST_ROLES` | the five roles the orchestrator delegates to |
| `SystemName` / `SYSTEM_NAMES` | `mne, occ, crew, pss, airport, handler, engineers` |
| `StateSystemName` / `STATE_SYSTEM_NAMES` | `SystemName` + `record` (everything persisted as `SYS#` rows) |
| `ToolSystem` | `SystemName` + `knowledge, record, runtime, comms` |
| `Tier` | `execute, propose, forbidden` |
| `RunMode` | `agent, baseline` |
| `RunStatus` | `created, running, paused, completed, aborted, failed` |
| `ProviderId` | `anthropic, openai, bedrock, replay, scripted` |
| `RefKind` | `tail, station, flight, cohort, crew, engineer, stand, defect, workOrder, approval` |
| `KnowledgeCollection` | `mel, procedure, passenger_rights, precedent, rules` |
| `Jurisdiction` | `EU, UK, US` |
| `Actor` | `{kind:'agent', role}` · `{kind:'human', name, roleTitle}` · `{kind:'policy', policy:'baseline'\|'eval-auto'\|'simulation-auto'}` · `{kind:'world'}` |
| `SCENARIO_IDS`, `SHIPPED_SCENARIOS` | the ten fixed ids (with title, station, twist) |
| `CARRIER` | `{name:'Accent Air', code:'ACX', mainBase:'MAN'}` |
| Patterns | `FLIGHT_NUMBER_PATTERN` `^ACX[1-9][0-9]{2}$`, `TAIL_PATTERN` `^AX-[A-Z]{3}$`, `IATA_PATTERN`, `HHMM_PATTERN`, `SCENARIO_ID_PATTERN` `^[a-z0-9-]{3,64}$` |

Human-only decisions (deferral, release, FDP extension, departure) must be recorded with `Actor.kind === 'human'`;
the mne system only accepts a deferral/release from a human whose `roleTitle` contains "Certifying".

## 2. Scenario (`src/scenario.ts` → `scenario.schema.json`)

`Scenario` (spec §8, `schemaVersion: 1`). Generated file: `packages/schema/scenario.schema.json`
(`npm run -w @ica/schema gen`; a test fails if it is stale). Objects are **strict** (`additionalProperties: false`),
so authored scenarios cannot smuggle extra fields.

```
Scenario { schemaVersion: 1; id; title; narrative (untrusted); visibility: 'public'|'private';
  inspiredBy: {sourceId, url, note}[]            // verified references only, never invented
  startSimTime: ISO                              // sim minute 0
  aircraft: {tail AX-XXX, type A319|A320|A321|B737|B738|E190, station IATA, stand?, nextSectors: Sector[]}
  trigger: {type, atMinute, description, evidence: {kind: photo-description|techlog|report|sensor, text}[]}
  world: {spares[], engineers[], crew[], cohorts[], stands[], handler, weather, curfews[], rotation[], distanceTableKm?}
  twists: {id, title, atMinute? (omitted = manual only), description, effects: TwistEffect[]}[]
  baseline: {atMinute, actor, action: {tool, args, decision?: approve|reject}, note}[]
  expected: ExpectedConstraints
  kpiParams: {eurPerMinute, reactionaryFactor, eu261TierEur?: 250|400|600, cancellationFixedEur,
              careEurPerPaxPerHour, accommodationEurPerPax} }
TwistEffect = {op:'patch', system, entity, id, patch} | {op:'create', system, entity, record}
            | {op:'delay', flight, minutes} | {op:'info', text}
ExpectedConstraints = {noSoftwareDeferral, noFdpExtension, firstPaxMessageBeforeMin?, engineerPagedBeforeMin?,
  decisionBeforeMin?, requiredTools[], forbiddenTools[], orderedPairs: [before, after][], referenceSummary}
```

- `validateScenario(x) → {ok:true, value} | {ok:false, errors: string[]}` runs the JSON Schema plus cross-field
  checks (duplicate engineer/crew/cohort/stand/twist ids). Errors are `"/json/pointer message"`.
- Flight numbers (`nextSectors`, `rotation`, `cohorts`) must match `^ACX[1-9][0-9]{2}$`; tails `^AX-[A-Z]{3}$`.
- `world.handler` and `world.weather` describe the **incident station**.
- `DEFAULT_KPI_PARAMS` = €100/min, factor 1.8, €18,600 cancellation, €8/pax/h care, €120/pax accommodation.
- `renderScenarioSchemaFile()`, `scenarioJsonSchema` (plain object), `SCENARIO_SCHEMA_ID`.
- Twist `patch`/`create` entity names are the `SYSTEM_ENTITIES` names (e.g. `engineers`/`engineers`, `occ`/`flights`).

## 3. Mocked-system state (`src/systems.ts`)

`SystemState[system][entity][id] = Entity`. Every map is keyed by the entity's natural id (`ENTITY_KEY`). Times inside
the sim are `…Minute` numbers; `std/sta/etd/reportTime` are ISO strings on the scenario clock.

| System | Entity (map name) → type | Key |
|---|---|---|
| `mne` | `aircraft` → `Aircraft{tail,type,station,status: serviceable\|unserviceable\|aog\|released,stand?}` | `tail` |
| | `defects` → `Defect{id,tail,description,ata?,status: open\|deferred\|rectified,melItem?,raisedAtMinute,deferredBy?:Actor}` | `id` |
| | `workOrders` → `WorkOrder{id,tail,defectId?,task,status: created→assigned→in_progress→awaiting_certification→closed,assignedEngineerId?,createdAtMinute,estimatedDurationMin,progressPct}` | `id` |
| | `techlog` → `TechlogEntry{id,tail,text,status: draft\|approved,aiDrafted:true}` | `id` |
| | `decisions` → `EngineeringDecision{id,tail,decision: rectify\|defer_mel\|aog\|release,decidedBy:Actor(human),atMinute,rationale}` | `id` |
| `occ` | `flights` → `Flight{flight,tail,from,to,std,sta,etd?,status: scheduled\|delayed\|boarding\|departed\|cancelled\|swapped,delayMin,reactionaryDelayMin,pax}` | `flight` |
| | `spares` → `Spare{tail,type,station,availableFromMinute,assignedTo?}` | `tail` |
| | `swaps` → `SwapDecision{id,fromTail,toTail,flights[],status,approvedBy?}` | `id` |
| | `cancellations` → `CancelDecision{id,flight,status,approvedBy?}` | `id` |
| | `curfews` → `Curfew{station,fromLocal,toLocal}` | `station` |
| `crew` | `crew` → `CrewMember{id,name,rank,status: operating\|standby\|assigned\|off,station,reportTime,sectorsPlanned,maxFdpMin,fdpUsedMin,fdpRemainingMin,assignedFlight?}` | `id` |
| `pss` | `cohorts` → `Cohort{id,kind,count,flight,status: uninformed\|informed\|care_issued\|rebooked\|waiting,firstInformedAtMinute?,careIssued,rebookedTo?,onwardDeadline?,notes?}` | `id` |
| | `rebookingOptions` → `RebookingOption{flight,from,to,std,seatsAvailable}` | `flight` |
| | `vouchers` → `Voucher{id,cohortId,kind: meal\|refreshment\|hotel\|transport,valueEur,issuedAtMinute}` | `id` |
| | `messages` → `PassengerMessage{id,cohortIds[],channel: sms\|email\|app,body,status: draft\|pending_approval\|sent\|blocked,aiDrafted:true,sentAtMinute?,approvedBy?}` | `id` |
| `airport` | `stands` → `Stand{id,station,kind: contact\|remote,occupiedByTail?,occupiedUntilMinute?}` | `id` |
| | `standRequests` → `StandRequest{id,standId,tail,status: requested\|confirmed\|rejected,confirmAtMinute}` | `id` |
| | `resourceRequests` → `ResourceRequest{id,kind: bus\|stairs\|tow\|gpu\|fire_service,station,status: requested\|confirmed\|en_route\|on_site\|released,etaMinute}` | `id` |
| | `weather` → `Weather{station,summary,windKt?,tempC?,metar?}` | `station` |
| `handler` | `tasks` → `HandlerTask{id,station,kind,status: queued\|acknowledged\|in_progress\|done,ackAtMinute,note}` | `id` |
| | `equipment` → `EquipmentPool{id,station,kind,available,total}` (`id = "{station}:{kind}"`) | `id` |
| | `reports` → `OccurrenceReport{id,station,text,status: draft\|filed_by_human}` | `id` |
| `engineers` | `engineers` → `Engineer{id,name,station,licence,skills[],status: available\|paged\|travelling\|on_site\|busy,location,etaMinute?,travelMode?: drive\|fly\|walk,destination?}` | `id` |
| `record` | `timeline` → `TimelineEntry{id,atMinute,text,source}` | `id` |
| | `reports` → `ReportDraft{id,kind: occurrence\|discretion,body,status:'draft',forHumanReporter:true,aiDrafted?,createdAtMinute?}` | `id` |
| | `evidencePacks` → `EvidencePack{id,createdAtMinute,contents:{timeline?,decisions?,messages?,reports?,kpis?,citations?}}` | `id` |

Exports: `SYSTEM_ENTITIES` (inspector tabs, display order), `ENTITY_KEY`, `SYSTEM_ENTITY_SCHEMAS` (TypeBox per
entity, for tests), `SystemEntityTypes`, `SystemStateOf<S>`, `SystemState`, `LooseSystemState`, `emptySystemState()`.

## 4. Events (`src/events.ts`)

```ts
RunEvent<T> = { runId; seq /* 1-based, gap-free */; type: T; actor: Actor; agentRunId?; parentAgentRunId?;
  iteration?; simMinute /* float */; simTime /* ISO */; wallTime /* ISO */;
  usage?: {inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd, model, provider};
  latencyMs?; traceKey? /* traces/{runId}/{seq}.json */; payload: EventPayloadMap[T] }
```

`RunEvent` (no type argument) is the discriminated union; narrow on `e.type` or with `isEvent(e, 'agent.proposal')`.
`EventDraft` is an event without `runId`/`seq` (and optional `wallTime`): the input to `Store.append`. `draft(type,
payload, envelope)` builds one type-safely. `eventSortKey(seq)` → `EVT#00000042`.

| type | payload |
|---|---|
| `run.created` | `{scenarioId, mode, pairedRunId?, speed, config: {provider, model, limits: RunLimits, fallback?}}` |
| `run.started` / `run.paused` / `run.resumed` | `{speed}` |
| `run.speed_changed` *(addition)* | `{speed}` — emitted by the runtime after applying `control.requested{set_speed}` |
| `run.completed` | `{reason: report\|horizon\|stopped, totals: RunTotals, finalKpis: KpiSnapshot}` |
| `run.failed` | `{error, where}` |
| `world.tick` | `{simMinute}` — once per sim minute |
| `world.twist` | `{twistId?, title, description, source: scheduled\|manual\|free_text, effects}` |
| `world.process` | `{system, entity, id, change}` — the mutations follow as `system.mutation` |
| `kpi.update` | `KpiSnapshot` |
| `system.mutation` | `{system: StateSystemName, entity, id, op: create\|update\|delete, before?, after?, causedBySeq?}` |
| `agent.started` | `{role, brief, parentAgentRunId?}` |
| `agent.thought` | `{text, summary ≤120}` |
| `agent.tool_call` | `{toolCallId, tool, system: ToolSystem, tier, args, presenterTriggered?, normalisedFrom?, argsRepaired?, argsTruncated?}` |
| `agent.tool_result` | `{toolCallId, tool, ok, resultPreview ≤500, result?, citations?, deduplicatedFrom?}` |
| `agent.proposal` | `{approvalId, toolCallId, tool, args, summary, reasoning, options?: DecisionOption[], expiresAtMinute?, tier?, unresolvedChecks?, approvalScope?, citations?, dataAsOfMinute?, assumptions?, supersedesApprovalId?}` |
| `approval.decision` | `{approvalId, decision: approve\|edit\|reject, editedArgs?, selectedOptionId?, reason?, decidedBy: Actor}` |
| `approval.invalidated` *(addition)* | `{approvalId, affectedAssumptions: {key, was, now, source?}[], causedBySeq?, role?}` — an assumption of an approved proposal changed |
| `agent.report` | `{role, report: AgentReport}` |
| `agent.aborted` | `{role, reason: iterations\|tool_calls\|tokens\|wall_clock\|budget\|error\|stopped, detail}` |
| `guardrail.blocked` | `{layer: tier\|input_screen\|output_screen\|arg_validation\|ref_validation, tool?, reason, excerpt?, toolCallId?, rule?, authority?, presenterTriggered?}` |
| `guardrail.flagged` | `{layer, tool?, reason, excerpt?, toolCallId?, findings?[{pattern, excerpt}]}`: a NON-blocking screening finding (addition, live run 2); not counted as a block |
| `twist.requested` | `{twistId?, text?}` — written by the API, drained by the Run Lambda |
| `control.requested` | `{action: pause\|resume\|stop\|set_speed\|demo_forbidden, speed?, tool?}` — written by the API |
| `baseline.action` | `{actor, tool, args, note}` |
| `llm.fallback` | `{from: {provider, model}, to: {provider, model}, reason}` |
| `scenario.authoring` *(addition)* | `{status: started\|patched\|fallback, detail, errors?, costUsd?}` — preparing a flight-context scenario from free text before `run.started` (actor `world`) |

Rules:

- **`system.mutation.after` is the FULL entity after the change**, never a patch; omitted for `delete`.
  Every persisted `SystemMutation` must be accompanied by one `system.mutation` event in the same `append` call —
  build it with `mutationDraft(mutation, envelope, causedBySeq?)`. The reducer rebuilds state from these events only.
- Payload validators allow unknown extra fields (forward compatibility); envelopes and payload fields listed above are
  checked. `validateEvent(x)` rejects unknown `type`s.
- Seed state is emitted as `system.mutation` events (actor `world`) right after `run.started`.
- Baseline runs use `agentRunId: 'baseline'` and human actors.
- Speed: 1–30 via the API (`CreateRunRequest.speed`, `control.requested`); event schemas allow 0–60.

Supporting types (`src/common.ts`): `Citation{sourceId,url,title,quote ≤300,chunkId}`,
`DecisionOption{id,label,metrics:{timeToDepartureMin,costEur,customerImpact 0–100,compliant,constraints[]},recommended}`,
`AgentReport{summary,actionsTaken[],openIssues[],recommendations[],citations[]}`,
`RunTotals{inputTokens,outputTokens,costUsd,toolCalls,iterations,wallMs}` (`ZERO_TOTALS`), `Usage`,
`RunLimits{maxIterationsPerAgent,maxToolCallsPerRun,maxToolCallsPerAgent?,maxInputTokensPerRun,wallClockMs,budgetUsd,horizonMin}`
(`DEFAULT_RUN_LIMITS` = 25 / 0 (no run cap) / 60 per agent / 0 / 14 min / 0 / 180; `EVAL_RUN_LIMITS` = 12 / 40 / 40 / 80k / 8 min / $2.00 / 60;
0 = no limit for the tool-call, token and budget caps),
`ProviderModel`, `ScreeningResult{verdict: clean|neutralised|rejected, findings[{pattern,excerpt}], neutralisedText?}`.

### Approvals

`ApprovalRecord` (`APR#` row): `{runId, approvalId, status: pending|approved|edited|rejected|expired, agentRunId, role,
toolCallId, tool, args, summary, reasoning?, options?, proposalSeq, createdAtMinute, expiresAtMinute?,
decision?: {decision, editedArgs?, selectedOptionId?, reason?, decidedBy, seq, decidedAt}}`.
The runtime writes it (pending) together with `agent.proposal`; the API (or a policy) appends `approval.decision` and
updates the record. `approvalStatusFor(decision)` maps approve/edit/reject → approved/edited/rejected.

## 5. Reducer (`src/reducer.ts`)

`applyEvent(state: RunProjection, e: RunEvent): RunProjection` — pure, deterministic, used by UI, evals and API.
`foldEvents(events, initial?)`, `emptyProjection(runId?)`.

- Ignores events with `seq <= state.lastSeq` (duplicates); does **not** detect gaps (the stream client must re-fetch).
- Unknown event types only advance `lastSeq`/`simMinute`.
- `RunProjection`: `runId, lastSeq, meta {scenarioId, mode, pairedRunId?, status, speed, llm?, limits?,
  completedReason?, error?, createdSeq?, startedWallTime?, endedWallTime?}, simMinute, simTime, systems: SystemState,
  lastMutation {seq, system, entity, id, op} | null, approvals: Record<id, ProjectedApproval>, pendingApprovalIds[],
  kpis: KpiSnapshot | null, agents: Record<agentRunId, ProjectedAgent>, twists[], guardrailBlocks[], fallbacks[],
  baselineActions, totals: RunTotals`.
- `ProjectedAgent.status`: `running → awaiting_approval` (on its `agent.proposal`) `→ running` (when all its approvals
  are decided) `→ done` (`agent.report`) or `aborted`.
- Totals: tokens/cost summed from `usage`, `toolCalls` from `agent.tool_call`, `iterations` from `agent.thought`;
  replaced by `run.completed.totals`.

## 6. KPIs (`src/kpi.ts`, types only)

`Kpi<T> = {value, formula, inputs: Record<string, number|string|boolean|null>, contributingSeqs: number[]}`.
`KpiSnapshot = {simMinute, incidentClockMin, minutesTo3h, delayCostEur, eu261ExposureEur, cancellationCostEur,
totalCostEur, satisfaction (0–100), compliance {art14NoticeIssued, reroutingOfferedWithin3h|null, fdpRespected,
morDraftedWithin72h, threeHourThresholdAvoided|null}, safety {forbiddenAttempts, humanDecisionsBeforeDependentActions,
dependentActionsWithoutDecision}, latency {firstEngineeringDecisionMin|null, firstPaxMessageMin|null,
swapOrCancelDecisionMin|null}}`. Formulas: task 02 (`services/run/world/kpi.ts`). `KPI_KEYS` lists the Kpi fields.

## 7. Runtime interfaces (`src/runtime.ts`)

- `ToolDefinition<I, O> {name, description, inputSchema, tier, system, roles, mutates, outputScreen?: {kind:
  passenger_message|techlog|report, fields: JSON pointers}, refs?: {path, kind: RefKind}[], handler(input, ctx)}`.
- `ToolOutcome<O> = {ok:true, data, mutations?, citations?, followUps?: WorldScheduled[]} | {ok:false, error}`.
- `SystemMutation {system: StateSystemName, entity, id, op, after?, before?}`; `WorldScheduled {atMinute, description,
  mutations}` (applied by the world engine at `atMinute`, with a `world.process` event).
- `ToolContext {runId, agentRunId, role, actor, simMinute, state: Readonly<SystemState>, scenario, knowledge, rng, log}`.
- `MockSystem<Name> {name, seed(scenario, rng) → SystemState[Name], tick(state, simMinute, dtMin) → SystemMutation[],
  knownRefs(state) → Partial<Record<RefKind, string[]>>}`.
- `RoleDefinition {role, title, systemPrompt (constant), tools (domain tool names), maxIterations?, temperature?,
  reportSchema, stop:'report_tool'}`. The runtime prepends its `DATA_HANDLING_PREAMBLE` and adds runtime tools.
- `KnowledgeIndex.search({query, collections?, jurisdiction?, k?}) → KnowledgeHit[]`;
  `KnowledgeHit {chunkId, sourceId, url, title, section?, jurisdiction?, date?, collection, text, score, docId?,
  header?, rerankScore?}` (`text` is verbatim; `header` is the structural context, never quoted).
- LLM layer: `LlmProvider {id, complete(LlmRequest) → LlmResponse}`; `LlmRequest {model, system, messages:
  LlmMessage[], tools: LlmToolSpec[], maxTokens, temperature ≤0.2, cacheHints?, signal?, meta?}`;
  `LlmMessage {role: user|assistant, content: (text{cache?} | tool_use{id,name,input} | tool_result{toolUseId,
  content,isError?})[]}`; `LlmResponse {text, toolCalls[{id,name,input}], usage: LlmUsage, stopReason, model, raw?}`;
  `LlmConfig {provider, model, fallback?, temperature, maxTokens, limits}`; `WallClock {now, sleep}`.
- `RunDeps {store, traces, knowledge, llm, clock?, approvalsPolicy?: human|baseline|eval-auto, secrets?, bus?,
  providers?, simAutoApproveAfterMs?}`; `ExecuteRunInput {runId, deps, signal?}`; `AuthorResult {scenario?, errors?, screening}`.

## 8. API (`src/api.ts`)

| Route | Request | Response |
|---|---|---|
| `GET /scenarios` | – | `{items: ScenarioSummary[]}` |
| `GET /scenarios/{id}` | – | `Scenario` |
| `POST /scenarios/author` | `AuthorScenarioRequest {text ≤8000}` | **202** `{draftId, status: 'pending', screening}` (422 when screening rejects) |
| `GET /scenarios/drafts/{id}` *(addition)* | – | `AuthorDraft {draftId, status: pending\|ready\|failed, createdAt, updatedAt?, screening, scenario?, errors?}` |
| `POST /runs` | `CreateRunRequest {scenarioId? \| flightContext {seed, date, flightId, at?} + incidentType (+ text?, withBaseline?), mode, speed? 1–30, pairedRunId?}` (exactly one of `scenarioId` / `flightContext`) | **201** `{runId, scenarioId?, screening?, pairedRunId?, preparing?}` (`authorFallback?` is no longer set) |
| `GET /runs?limit=` | – | `{items: RunMeta[]}` |
| `GET /runs/{id}` | – | `RunMeta` |
| `GET /runs/{id}/events?after=&limit=` | limit ≤ `MAX_EVENTS_PAGE` (500) | `{events, lastSeq, hasMore}` |
| `POST /runs/{id}/approvals/{approvalId}` | `ApprovalDecisionRequest {decision, editedArgs?, selectedOptionId?, reason?, roleTitle?, policy?: 'simulation-auto'}` | `{accepted: true, seq}` |
| `POST /runs/{id}/twists` | `TwistRequest {twistId} \| {text ≤2000}` | `{accepted, seq?, screening?}` |
| `POST /runs/{id}/control` | `ControlRequest {action, speed?, tool?}` | `{accepted, seq}` |
| `GET /runs/{id}/systems/{name}` | – | `{system, entities, asOfSeq}` |
| `GET /runs/{id}/export` | – | `{trace: RunEvent[] \| {url}, evidencePack?}` |
| `GET /config` | – | `AppConfig {brand: BrandPack, features {webSearch, liveWeather, narrator, sideBySide}, stations: Station[], limits {maxRunsPerDay, runBudgetUsd, horizonMin, speedMin, speedMax}}` |
| `GET /evals/latest` | – | `EvalReport` |
| `GET /runs/{id}/audit?cursor=&limit=` *(addition)* | limit ≤ `AUDIT_PAGE_MAX` (2000, default 500) | `RunAuditResponse {runId, runName, scenarioId, scenarioTitle, flight?, mode, status, createdAt, startSimTime?, total, entries: AuditEntry[], nextCursor?, tracesListed}` |
| `GET /runs/{id}/audit/llm?key=` *(addition)* | `key` must be `traces/{runId}/{name}.json` of this run | `RunAuditLlmResponse {key, sizeBytes, trace? \| url?}` (5-minute presigned URL above `AUDIT_LLM_INLINE_MAX_BYTES`, 5 MB) |

`API_ROUTES` names every route. Request bodies have TypeBox schemas (`…RequestSchema`, strict) — validate with
`compileSchema(schema)`. Errors: `ApiError {error, code}`. WebSocket: connect with `?token=<JWT>&runId=<id>`;
server → client `WsServerMessage = {kind:'events', runId, events} | {kind:'ping'}`; client may send `{action:'ping'}`.
`WebRuntimeConfig` (`/config.json` next to the SPA): `{apiUrl, wsUrl, auth: {mode:'none'} | {mode:'cognito', region,
userPoolId, clientId, domain, redirectUri}}`.

Records: `RunMeta {runId, scenarioId, scenarioTitle, mode, status, pairedRunId?, createdAt, simMinute, lastSeq, totals,
speed, llm?, updatedAt?, endedAt?, error?, preparing?}`; `ScenarioSummary {id, title, station, aircraftType, triggerType,
visibility, twistCount, inspiredBy}` (`summariseScenario(s)`); `BrandPack {carrierName, carrierCode, logoSvg?,
colours {primary, accent}, consultancyName?, stations[], disclaimer}`; `Station {iata, name, lat, lon, country}`;
`EvalReport {id, createdAt, tier, gitSha?, caseCount, passRateByLayer, hardAssertionPassRate, judgeMean|null,
spend {usd, gbp}, ledger {lifetimeCapGbp, spentGbp, reservedGbp, remainingGbp}, cases[{caseId, scenarioId, passed,
skippedReason?}], markdown?}` (task 02 may add fields).

## 9. Validators (`src/validate.ts`)

`createAjv()` (Ajv 2020-12, allErrors, strict, formats), `compileSchema(schema) → (x) => ValidationResult`,
`validateScenario`, `validateEvent`, `isEventType`, `formatAjvErrors`. Use `createAjv()` for tool input schemas too, so
settings match.

## 10. Persistence (`@ica/store`)

Interfaces (defined in `@ica/schema/src/persistence.ts` to avoid a package cycle, re-exported by `@ica/store`):

```ts
interface Store {
  putScenario(s); getScenario(id); listScenarios(): ScenarioSummary[];
  createRun(meta); getRun(runId); updateRun(runId, patch /* lastSeq ignored */); listRuns(limit /* newest first */);
  countRunsSince(isoTime);
  append(runId, drafts: EventDraft[], mutations?: SystemMutation[]): RunEvent[];   // atomic; assigns seq
  listEvents(runId, afterSeq, limit = 500): {events, lastSeq, hasMore};
  putApproval(a); getApproval(runId, approvalId); listApprovals(runId, status?);
  getSystemState(runId, system?: StateSystemName): Partial<SystemState>;          // all entity maps present
  putConnection(connId, runId); deleteConnection(connId); listConnections(runId);
  putEvalReport(r); getLatestEvalReport();
}
interface EventBus { subscribe(runId, onEvents) → unsubscribe; publish(runId, events) }
interface TraceStore { put(runId, seq: number|string, body, {suffix?}) → key; get(key); list?(runId) → TraceObjectInfo[] }
interface SecretStore { get(name) }
class RunNotFoundError
```

- `append` throws `RunNotFoundError` for an unknown run, assigns `lastSeq+1…`, commits events + `SYS#` rows together,
  and advances `RunMeta.lastSeq` and `simMinute`. An empty call is a no-op.
- Implementations: `MemoryStore({bus?, validateEvents = true, now?})` (validates every event against the schema,
  publishes to the bus, `snapshot()`/`MemoryStore.fromSnapshot()` for `LOCAL_PERSIST`), `MemoryEventBus`,
  `DynamoStore({tableName, client?, region?, endpoint?, traces?, maxRetries = 5})`, `FsTraceStore(root = '.local')`,
  `MemoryTraceStore`, `S3TraceStore({bucket})`, `EnvSecretStore`, `SecretsManagerSecretStore({secretIds: ['ica/llm',
  'ica/search']})` (JSON secrets, cached per container, missing secrets tolerated).
- Trace keys: `traces/{runId}/{seq}{suffix}.json` (`traceKey()`); `seq` may be a label such as `llm-{agentRunId}-{i}`.
- DynamoDB layout (`keys.ts`, ADR 0004): `SCN#{id}/META` (GSI1 `SCN`/`{id}`), `RUN#{id}/META` (GSI1
  `RUNS`/`{createdAt}#{runId}`), `RUN#{id}/EVT#{seq:08d}` (attrs `type, seq, ttl, event`, TTL 30 days),
  `RUN#{id}/APR#{approvalId}` (`status, record`), `RUN#{id}/SYS#{system}#{entity}#{id}` (`system, entity, id, data`),
  `WS#{conn}/RUN#{id}` (GSI1 `RUN#{id}`/`WS#{conn}`, attrs `connectionId, runId`), `EVAL#{id}/META` (GSI1
  `EVAL`/`{createdAt}#{id}`, `report`). GSI1 must project ALL.
- Event rows over 32 KB: full event in the TraceStore at `traces/{runId}/{seq}.payload.json`, row keeps
  `payloadKey` and `event.payload = {_truncated: true, preview}`. **The fan-out Lambda must use
  `itemToEvent(unmarshall(NewImage), traces)`** to rehydrate.
- `append` protocol: optimistic `lastSeq` condition on META, `attribute_not_exists(SK)` on events, retry ≤5 with
  jitter on condition failure; batches over 99 items are split into several transactions, each keeping mutations
  with their `system.mutation` event (the whole batch is then not atomic, only each chunk).
- Conformance suite: `runStoreConformance(name, factory)` from `@ica/store/conformance` (vitest). Runs on
  `MemoryStore` always and on `DynamoStore` when `DYNAMO_ENDPOINT` is set (DynamoDB Local).

## 11. Additions log

Additions beyond the task-01 brief (all optional or new, none breaking):

| Where | Addition | Why |
|---|---|---|
| ids | `StateSystemName`, `STATE_SYSTEM_NAMES` (`SystemName` + `record`) | `record` is persisted like a system (export needs the evidence pack) |
| ids | `SPECIALIST_ROLES`, `PROVIDER_IDS`, `REF_KINDS`, `KNOWLEDGE_COLLECTIONS`, `JURISDICTIONS`, `CARRIER`, `SHIPPED_SCENARIOS`, id patterns | shared constants |
| systems | `SystemState` includes `record`; `ENTITY_KEY`, `SYSTEM_ENTITY_SCHEMAS`, `emptySystemState()` | keyed maps, tests |
| systems | `EquipmentPool.id`, `Engineer.destination?`, `Cohort.notes?`, `ReportDraft.aiDrafted?`/`createdAtMinute?`, `SwapDecision/CancelDecision.status` = `proposed\|approved\|rejected\|executed`, structured `EvidencePack.contents` | gaps in the brief |
| events | `run.speed_changed` event | the effect of `control.requested{set_speed}` |
| events | `run.created.config.fallback?`, `agent.proposal.tier?`, `guardrail.blocked.toolCallId?` | UI badges, linking |
| events | `ApprovalRecord` shape, `approvalStatusFor`, `draft()`, `isEvent()`, `eventSortKey()` | shared by 02/04/05 |
| common | `ScreeningResult.neutralisedText?`, `RunLimits` (+ `horizonMin`, `budgetUsd`), `DEFAULT_RUN_LIMITS`, `EVAL_RUN_LIMITS`, `ZERO_TOTALS`, `Usage`, `ProviderModel` | runtime limits |
| runtime | `SystemMutation.before?`, `WorldScheduled` shape, `mutationDraft()`, LLM message/request/response types, `LlmConfig`, `WallClock`, `RunDeps.secrets?/bus?/providers?`, `KnowledgeQuery` | spec §6 shapes made concrete |
| api | `ApprovalDecisionRequest.roleTitle?`, `RunMeta.llm?/updatedAt?/endedAt?/error?`, `API_ROUTES`, `MAX_EVENTS_PAGE`, `ScenarioSummary` shape, `summariseScenario()`, `EvalReport` shape, `WsClientMessage` | route contracts |
| schema (task 05) | `@ica/schema/browser` export (`src/browser.ts`): everything except the Ajv validators | `validate.ts` compiles every schema at import time (`new Function`); the SPA must not pay for it on first paint, and a strict CSP forbids it |
| store | Interfaces live in `@ica/schema/src/persistence.ts` (re-exported); `EventBus.publish`; `TraceStore.put(…, {suffix})` and string seq labels; `MemoryTraceStore`; `MemoryStore.snapshot()/fromSnapshot()`; `itemToEvent()`; GSI1 used for runs/scenarios/evals | no package cycle; no Scans; payload overflow |
| systems (task 03) | `Flight.stdMinute?`/`staMinute?`, `WorkOrder.startedAtMinute?`, `ResourceRequest.releaseAtMinute?`/`tail?`, `HandlerTask.doneAtMinute?`/`tail?`/`equipmentKind?`, `Engineer.availableFromMinute?` | pure `tick()`s need sim-minute anchors (no scenario in `tick`) and release/completion times |
| runtime (task 03) | `ToolContext.approvedBy?: Actor` | the deciding actor when a `propose` tool runs after approval; recorded as approver / `decidedBy` |
| runtime (task 02) | `LlmMessage.providerContent?` / `LlmResponse.providerContent?` (`LlmProviderContent {provider, model, content[]}`) | round-trip native assistant blocks (e.g. Anthropic thinking blocks on models where thinking cannot be disabled) |
| runtime (task 02) | `LlmRequest.cacheHints.messages?` | moving prompt-cache breakpoint on the last message (incremental conversation caching) |
| store (integration) | `lambdaSecretIds(env)`, `DEFAULT_SECRET_IDS`, `envHydratedSecretNames(env)`, `ENV_HYDRATED_SECRETS`, `hydrateEnvFromSecrets()` | one source of truth for the Lambda secret env names (`LLM_SECRET_ARN`/`SEARCH_SECRET_ARN`) shared by the Run and author Lambdas; web search / openai embedder keys copied into `process.env` |
| runtime (integration) | `ToolContext.kpis?: KpiSnapshot` (latest world-engine snapshot, read-only); `EvidencePack.contents.kpis.snapshot` | `export_evidence_pack` attaches the KPI snapshot (spec: evidence pack includes KPIs) |
| store (integration) | `Store.decideApproval(runId, approvalId, expectedStatus, patch): Promise<boolean>`, `ApprovalPatch` (MemoryStore; DynamoStore `UpdateCommand` with `ConditionExpression #s = :expected`) + conformance test | the API claims an approval atomically before writing `approval.decision`, so two simultaneous decisions cannot both be accepted |
| schema (task 06) | `BrandPack.productName?` (default "Incident Coordination Agent") | product rename; stack ids, package scope, table and bucket names unchanged (ADR 0007) |
| events (task 06) | `CONTROL_ACTIONS` + `demo_forbidden`; `DEMO_FORBIDDEN_TOOLS`; `control.requested.tool?`, `ControlRequest.tool?`; `agent.tool_call.presenterTriggered?`; `guardrail.blocked.{rule?, authority?, presenterTriggered?}` | presenter's "Demonstrate blocked action": a synthetic call through the REAL tier gate, counted like any attempt |
| common/events (task 06) | `ApprovalScope`, `Assumption`, `ProvenanceFields` (`unresolvedChecks?`, `approvalScope?`, `citations?`, `dataAsOfMinute?`) on `agent.proposal`, `DecisionOption` and `AgentReport.recommendationDetails?` (`RecommendationDetail`) | every recommendation/decision card shows sources, timestamps, unresolved checks and approval scope |
| common (task 06) | `ProvisionalReading {text, confidence?, unconfirmed: true}`, `AgentReport.provisionalReading?`, `PROVISIONAL_READING_LABEL` | a model's reading of a defect is never a status |
| events (task 06) | `agent.proposal.{assumptions?, supersedesApprovalId?}`; new `approval.invalidated` event; reducer: `ProjectedApproval.{unresolvedChecks?, approvalScope?, citations?, dataAsOfMinute?, assumptions?, supersedesApprovalId?, supersededBy?, invalidated?}`, `ProjectedGuardrailBlock.{toolCallId?, rule?, authority?, presenterTriggered?}` | approval invalidation on a changed assumption (engineer ETA) and revised proposals |
| events (task 06) | `agent.tool_result.deduplicatedFrom?` | idempotent retries return the original result |
| runtime (task 06) | `ToolDefinition.{approvalScope?, approvalExclusions?, defaultUnresolvedChecks?, idempotencyKey?}` | scope from the tool definition; idempotency key (`/requestId`) |
| systems (task 06) | `requestId?` on `WorkOrder`, `HandlerTask`, `PassengerMessage`, `ResourceRequest`, `StandRequest`; `Engineer.pageRequestId?`; `CrewMember.assignmentRequestId?` | the systems dedupe on the client-generated request id |
| systems (task 06) | `DECISION_STATUSES` + `requested`; `SwapDecision.{requestedAtMinute?, confirmAtMinute?, occNote?}` | approving a swap sends a request; OCC confirms and executes it in `occ.tick` |
| systems/scenario (task 06) | `MaintenanceRecord` (`lastCheckType?`, `lastCheckDate?`, `defectHistory?`), `Aircraft.maintenance?`, `UNKNOWN`; scenario `aircraft.maintenance?` / `world.spares[].maintenance?` | missing maintenance data shows "Unknown", never a default |
| scenario (task 06) | `TwistEffect` `{op:'shift', system, entity, id, field, minutes}`; `ScenarioTwist.afterFirstApproval?` | the engineer-ETA +40 min twist that fires after the first approval (s01, s04) |
| events (live-run fix) | `agent.tool_call.normalisedFrom?` (a role-named call such as `ground{brief}` run as `delegate{role, brief}` under the same toolCallId); `agent.tool_call.argsRepaired?` (keys recovered from tool-call markup the model leaked into a string argument) | live run 1: parallel delegation was blocked as "unknown tool"; a report "missed" `actionsTaken` because it was inside `summary`. Both repairs stay auditable and still pass arg validation and the tier gate |
| common/events (live-run fix) | `AgentReportEventSchema` / `AgentReportEvent` = `AgentReport` + `extras?: Record<string, unknown>` (report keys the role schema does not define) + `composedByRuntime?: boolean`; used by `agent.report.report` and `ProjectedAgent.report`. The model-facing report schema is unchanged in shape, but relaxed at runtime: `actionsTaken` optional (merged with the agent's executed tool calls), unknown keys accepted | live run 1: a strict report schema made the agent send a placeholder report, which was accepted. Placeholder reports are now refused, and after 3 invalid attempts the runtime composes the report |
| ids/scenario (task 07, **owner-approved breaking rename**) | Carrier rebrand to **Accent Air**: `CARRIER = {name:'Accent Air', code:'ACX', mainBase:'MAN'}`, `FLIGHT_NUMBER_PATTERN` `^ACX[1-9][0-9]{2}$` (was `NWD…`), `TAIL_PATTERN` `^AX-[A-Z]{3}$` (was `NW-…`); every shipped scenario, fixture, recording and eval case rewritten with the same seeds (only the codes changed) | owner decision 2026-09-27 (ADR 0007). The only deliberate non-additive contract change; scenarios authored with the old codes no longer validate |
| network (task 07) | New package `@ica/network` (browser- and Node-safe): `generateDaySchedule(seed, date)`, `flightStateAt(flight, t)`, `suitableAirports(position, type, filters)` (options only, `OPTIONS_ONLY_NOTE`), `tailStatesAt`, `fdpMarginFor`, `cohortsFor`, station and airport-capability data (illustrative; fictional where invented) | the live-network home is computed in the browser at zero backend cost; the API rebuilds flight-context scenarios from the same code |
| api (task 07) | `CreateRunRequest.scenarioId` optional (exactly one of `scenarioId` or the new `flightContext` is required, checked by the route); `flightContext {seed, date, flightId, at?}` (`FlightContextSchema`), `incidentType`, `text?`; `CreateRunResponse.{scenarioId?, screening?, authorFallback?}` | "Report incident" on a live-network flight: the server rebuilds the scenario with `@ica/network/templates` (never trusts a client scenario), runs the Scenario Author on screened free text, stores the scenario privately |
| network (task 07) | `@ica/network/templates`: `INCIDENT_TYPES` (10 ground families + 5 airborne), `incidentContext`, `incidentTypesFor`, `buildScenarioFromFlight` (deterministic, schema-valid; `remap` for recordings), `authorRequestText`; `@ica/scenarios/templates` export (the static JSON index) | template-first incident reporting in the browser (preview, mock mode) and on the server (same code) |
| runtime (hybrid search) | `KnowledgeHit.{docId?, header?, rerankScore?}` | hits are collapsed per logical document (report, MEL item, rule sub-paragraph, article); the structural context header is returned apart from the verbatim `text` (quotes stay verbatim); the Cohere Rerank 3.5 relevance when the reranker ordered the hit. The knowledge tools expose `header` as `context` |
| ids (task 07) | `SCENARIO_IDS` / `SHIPPED_SCENARIOS` + five airborne scenarios (`s11-air-turnback-bird-strike`, `s12-diversion-smoke-fumes`, `s13-diversion-medical`, `s14-engine-shutdown-overweight-landing`, `s15-diversion-disruptive-passenger`); `AIRBORNE_SCENARIO_IDS`; `FLIGHT_DECK_FORBIDDEN_TOOLS` (`instruct_flight_crew`, `select_diversion_airport`, `approve_overweight_landing`) | airborne incidents; the commander's authority is forbidden-tier in code |
| systems (task 07) | `occ.airborne` (`AirborneFlight`, keyed by flight: phase, squawk, position fix, destination, ETA, notional endurance, commander decision) and `occ.commanderLog` (`CommanderLogEntry`, `decidedBy: "Commander"`); `SQUAWK_STATUSES`, `COMMANDER_DECISIONS`; `RESOURCE_KINDS` + `medical`, `police` | flight following and the commander's decisions, set only by scenario or presenter events (twists), never by agents |
| scenario (task 07) | `Scenario.airborne?` (`ScenarioAirborneSchema`: flight, from, plannedDestination, position, altitude, heading, etaMinute, fuelEnduranceMin, squawk, pax); `aircraft.station` is the arrival station | airborne scenarios; the regenerated `scenario.schema.json` |
| kpi (task 07) | `ComplianceValue.commanderAuthorityRespected?` (airborne only); `KpiSnapshot.diversionCostEur?` (estimate, included in `totalCostEur`) | the commander's authority as a compliance item; diversion and care-surge cost |
| api/events/runtime/store (async authoring fix, 2026-09-27) | **`POST /runs` with a flight context never waits for an LLM**: regex-only screening (`screenInputFast`), deterministic template scenario (stored private; a fresh id suffix when text is given; `other` uses the first startable family for the flight), `RunMeta.preparing?` + `scenario.authoring{started}`, async Run Lambda invoke `{runId, authoring: {text, label?}}` (`ExecuteRunInput.authoring?`, `AuthoringRequest`). `CreateRunRequest.withBaseline?` (flight context only) creates the paired baseline on the server; `CreateRunResponse.{pairedRunId?, preparing?}`. New event `scenario.authoring {status: started\|patched\|fallback, detail, errors?, costUsd?}` (`SCENARIO_AUTHORING_STATUSES`); reducer `meta.authoring? {status, detail, seq}`. `ScenarioPatchSchema` / `ScenarioPatch` / `applyScenarioPatch` / `SCENARIO_PATCH_LIMITS` / `PATCH_TWIST_PREFIX` (`src/scenario-patch.ts`, browser-safe). **`POST /scenarios/author` is async**: 202 `{draftId, status, screening}` (`AuthorScenarioResponse.{draftId?, status?}`), new route `getAuthorDraft` `GET /scenarios/drafts/{id}` → `AuthorDraft` (`AUTHOR_DRAFT_STATUSES`, `AUTHOR_DRAFT_STALE_MS` = 6 min: an older pending draft is reported failed). `Store.putAuthorDraft/getAuthorDraft` (MemoryStore + snapshot `drafts?`; DynamoStore `DRAFT#{id}/META`, TTL 1 day) + conformance tests | live 2026-09-27: `POST /runs` with free text hit API Gateway's 29 s limit (sync author Lambda invoke, whole-scenario generation ≥ 60 s). The Author now patches the template in the Run Lambda (≤ 4 iterations, ≤ 2 proposals, ≤ 2,048 output tokens, 45 s hard cap, fallback = template); a paired run waits for `preparing` to clear so both runs use the identical scenario |
| common (live run 2) | `RunLimits.maxToolCallsPerRun` minimum relaxed 1 → 0 (0 = no run-level cap); new optional `RunLimits.maxToolCallsPerAgent` (0/absent = none). `DEFAULT_RUN_LIMITS`: run cap 0, 60 per agent, wall clock 14 min (was 60/run, 8 min). `EVAL_RUN_LIMITS` unchanged (+ 40 per agent) | the shared 60-per-run cap stopped concurrent agents doing real work (`tool calls 60 ≥ 60`); owner decision: only loop-safety limits stop the product |
| events/common (live run 2) | New event `guardrail.flagged` (non-blocking screening finding); `AgentReportEvent.screeningFlags?: {pattern, excerpt}[]` | a maintenance report that quoted system state was rejected as a status claim; the screen now separates attributed state from the agent's own assertion, and a remaining claim in a report (agent → orchestrator) is flagged, not rejected. Tech-log drafts and passenger text stay blocking |
| events/runtime (live run 2) | `agent.tool_call.argsTruncated?: string[]` (JSON pointers truncated at their `maxLength`, suffix ` …[truncated]`); `ToolDefinition.splitOverlong?: string[]` (fields the tool splits itself, e.g. `append_timeline` `/text` → sequential entries) | a 560-char timeline entry was rejected at a 400-char cap; length-only failures on free-text fields are now accepted (truncated or split) instead of wasting a tool call. Free-text caps raised: timeline 2,000, techlog 2,000, rationale 2,000, incident summary 2,000, objective/question 1,000, brief 4,000, passenger message 1,000, stand plan 1,000 |
| api (task 08, owner request) | `BrandPack.about? {author, authorUrl, repoUrl?}` (optional; set only by a deployment's git-ignored `config/brand.local.json`. The public defaults and the web carry no credit: without `about.author` the About dialog and the Training footer show no author line) | the About dialog's credit and repository link are configurable per brand |
| runtime (live run 2) | `repairLeakedParameters(input, schema?)` / `repairCall(…, schemaOf?)`: leaked markup repaired for any tool using its argument names (`</k>`, `<k2>…</k2>`, `</parameter><parameter name="k2">`), JSON-parsed per schema type, never overwriting a validly provided key (`argsRepaired`) | a report's `openIssues` arrived inside `summary` as `…</summary> <openIssues>[…]` |
| ids/api/runtime (decisions & time fix) | `Actor` policy value **`simulation-auto`** (`SIMULATION_AUTO_POLICY`, `SIMULATION_AUTO_ACTOR`); `ApprovalDecisionRequest.policy?: 'simulation-auto'` (only with `decision: 'approve'`, no edits; 400 otherwise) → the API records `decidedBy: {kind:'policy', policy:'simulation-auto'}`, never the caller; `RunDeps.simAutoApproveAfterMs?` (absent = `DEFAULT_SIM_AUTO_APPROVE_AFTER_MS` = 120 000 ms real time; 0 = off) and `simAutoApproveAfterMsFromEnv(env)` (`SIM_AUTO_APPROVE_AFTER_MS`) | simulation auto-approval: the browser's decision popup approves after a 10 s countdown (pauses on hover/focus; ⌘K toggle, default on), and the runtime's `human`-policy wait auto-approves anything still pending after 120 s through the conditional claim (`Store.decideApproval`), so an unattended run never stalls and the two can never double-decide. Not applied to `baseline` or `eval-auto`. Shown everywhere as "Auto-approved (simulation)". Human-only domain rules still refuse a policy approver in code (e.g. an engineering decision) |
| api/store/schema (audit logs) | New routes `getRunAudit` `GET /runs/{id}/audit` and `getRunAuditLlm` `GET /runs/{id}/audit/llm?key=`; `src/audit.ts` (browser-safe): `AuditEntry` = `AuditLlmEntry {kind:'llm', traceKey, provider?, model?, usage?, costUsd?, latencyMs?, sizeBytes?, summary?, unmatched?}` \| `AuditToolEntry {kind:'tool', toolCallId, tool, system?, tier?, args?, ok?, result?, resultPreview?, error?, latencyMs?, normalisedFrom?, argsRepaired?, argsTruncated?, presenterTriggered?, deduplicatedFrom?, citations?, blocked?, proposal?, decision? {decision, decidedBy, …}}` (common: `id, agentRunId?, role?, iteration?, seq?, simMinute?, simTime?, wallTime?`), `RunAuditResponse`, `RunAuditLlmResponse`, `buildAuditEntries(events, traces)`, `parseLlmTraceKey`, `isRunTraceKey`, `auditRunName`, `AUDIT_PAGE_DEFAULT/MAX`, `AUDIT_LLM_INLINE_MAX_BYTES`. Optional `TraceStore.list?(runId) → TraceObjectInfo {key, size?, lastModified?}[]` (Memory, Fs, S3 `ListObjectsV2`); `traceRunPrefix()` | owner request: a full audit of what was sent to and returned by the model and the tools (the web Audit view). The API Lambda gets read-only `s3:GetObject` on `traces/*` and `s3:ListBucket` limited to `s3:prefix` `traces/*` |
| store (demo review 2026-09-27) | `DynamoStore.append` coalesces mutations per `SYS#{system}#{entity}#{id}` key within each transaction (last write wins; delete-after-put = delete; the paired `system.mutation` events stay as emitted; batch splitting dedupes per chunk). `MemoryStore` asserts the same invariant in dev/test (`MemoryStoreOptions.strictMutationKeys`, default on unless `NODE_ENV=production` or inside a Lambda; throws `DuplicateMutationKeyError`). Exports `coalesceMutations`, `duplicateMutationKeys`, `mutationKey` | live: both S01 runs failed with "Transaction request cannot include multiple operations on one item" (OCC's swap confirmation re-tailed then re-timed one flight in one tick). Producers now emit one net mutation per row (`netMutations`, services/run) |
| store (self-recovery) | `src/retry.ts`: `classifyError` / `isTransientError` (throttling, ProvisionedThroughputExceeded, RequestLimitExceeded, 5xx/429, network/timeouts, TransactionCanceled only by TransactionConflict → transient; ValidationException, ConditionalCheckFailed, others → permanent), `withRetry` (5 attempts, full jitter, cap 8 s), `backoffMs`, `RetryOptions`, `TRANSIENT_ERROR_NAMES`, `DEFAULT_RETRY_ATTEMPTS/CAP_MS`. `DynamoStoreOptions.retry?`, `S3TraceStoreOptions.retry?` (and `client` typed `Pick<S3Client,'send'>`), `SecretsManagerSecretStoreOptions.retry?`. Transactions retry the identical request with a `ClientRequestToken`; a transient Secrets Manager failure is not cached | owner request: retry transient infrastructure errors everywhere in the run path |
| store/api/runtime (self-recovery) | `Store.claimResume?(runId, attempt): Promise<boolean>` (optional; Memory + Dynamo `UpdateCommand` with `ConditionExpression attribute_not_exists(resumeAttempt) OR resumeAttempt < :a`; conformance test); `RunMeta.resumeAttempt?`; `ExecuteRunInput.resume? {attempt}`; `RunDeps.scheduleResume?(RunResumeRequest {runId, attempt, reason})`; `MAX_RUN_RESUMES` = 2; `LAMBDA_TIMEOUT_ABORT` (the Run Lambda's `AbortSignal.reason` when < 60 s remain) | a failed run (or one out of Lambda time with work left) resumes itself: async self-invoke `{runId, resume: {attempt}}`, state rebuilt from SYS# rows + the event log, sim clock kept, pending approvals re-attached, orchestrator restarted with a deterministic resume brief |
| events (self-recovery) | New events `run.recovering {attempt, reason, maxAttempts?}`, `run.resumed_after_error {attempt, fromMinute, pendingApprovals?}`, `system.error {scope: tool\|agent\|world\|store, message, tool?, toolCallId?, role?}` (`SYSTEM_ERROR_SCOPES`); reducer `meta.recovery? {status: 'recovering'\|'resumed', attempt, reason?, atMinute, seq}` (`run.resumed_after_error` sets status `running`) | the UI shows "Recovered from a system error — resumed at m{t}"; contained failures stay visible |
| events/audit (demo review) | `agent.tool_call.deduplicatedFrom?` (an identical call earlier in the same model turn: not executed, same result) and `agent.tool_call.cachedFrom?` / `agent.tool_result.cachedFrom?` (a read-only result served from the agent run's cache); `agent.tool_result.deduplicatedFrom` also marks same-turn duplicates; `AuditToolEntry.cachedFrom?`. Neither kind counts against the per-agent tool cap; the safety KPI ignores replays | Flight Ops called `get_crew_fdp` 14× in one turn |
| kpi (demo review) | **Semantics:** `SafetyValue.humanDecisionsBeforeDependentActions` counts only decisions with `decidedBy.kind === 'human'`. New `autoApprovedActions?` and `autoApprovedByPolicy?` (policy approvals: simulation-auto, eval-auto, baseline — never a human decision); KPI inputs `autoApproved:<policy>` | the UI shows ⚠ "auto-approved — not a human decision" |
| runtime (demo review) | `DEFAULT_SIM_AUTO_APPROVE_AFTER_MS` **120 000 → 0**: the server-side simulation safety net is OFF by default for agent runs (`SIM_AUTO_APPROVE_AFTER_MS` > 0 turns it on; invalid → off). Baseline and eval-auto policies unchanged | owner decision after the live demo: approvals wait for a person |
| systems (demo review) | `Engineer.pagedAtMinute?`, `pageReason?` (a second engineer's recorded reason, e.g. "backup"), `workOrderId?`, `pendingEtaDelayMin?` (an engineer-ETA twist that fired before anyone was on the way; added to the next page's ETA). `respondingEngineer(state, {tail?, station?, statuses?})` (browser-safe): THE engineer coming to the incident (assigned to an open work order first, then a non-backup page, on site first, then earliest ETA) — used by `get_aircraft_status` / `get_stand_status` and the twist resolver, for the cockpit's ground/airport ETA path too | live: four pages and a different engineer on the ground view; the +40 min twist was a silent no-op. Tools (not contracts): `page_engineer` is idempotent per engineer (`alreadyPaged`, no mutation), a second engineer needs `reason`, one assignment per work order; `get_crew_fdp` / `find_standby_crew` answer for the whole crew in one call; `report` args are coerced before validation (`argsRepaired`), refused only without a usable summary |
| runtime (demo review 2) | `ToolOutcome` failure `data?: unknown` (structured detail of a failure: sent to the model with the error and recorded as `agent.tool_result.result`); `ToolContext.priorCalls?: (tool) => PriorToolCall[]` and `PriorToolCall {toolCallId, args, ok, atMinute, result?}` (this agent run's earlier calls, from the event log) | live run-20260927-224750-2zcd8s: `page_engineer` re-paged the same busy engineer twice. A page that cannot be sent now lists the alternatives (name, licence, station, estimated ETA, why suitable) and an immediate retry of the same unavailable engineer is refused. Tools (not contracts): `page_engineer.reason` cap 60 → 500 (screened as report text); length leniency covers every free-text string field (no pattern/enum/const/format, any cap); `request_decision` per-option `recommended`, `recommendedOptionId` and `metrics.constraints` optional in the tool schema, derived from each other before validation (`argsRepaired`); `DecisionOption` on events is unchanged (always has `recommended`) |
| network (demo review 2) | `FlightIncidentContext.selected` (the flight the duty manager chose; `flight` may be the aircraft's current flight) and `placement: IncidentPlacement {kind: 'on_flight' \| 'turnaround' \| 'moved_on' \| 'not_there_yet', note?}`; `BuiltScenario.preview.placement?` | ACX125 selected at 22:47Z (landed at PMI 09:25Z, aircraft back at MAN) built an incident on ACX126 at PMI at 09:20Z. The incident is placed on the selected flight where the aircraft is now, and any move to another sector is said in the report dialog; the sim starts no earlier than the inbound in-block (and at the report time when the aircraft is there). The API rebuilds the identical scenario |
