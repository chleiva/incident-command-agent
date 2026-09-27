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
| `Actor` | `{kind:'agent', role}` · `{kind:'human', name, roleTitle}` · `{kind:'policy', policy:'baseline'\|'eval-auto'}` · `{kind:'world'}` |
| `SCENARIO_IDS`, `SHIPPED_SCENARIOS` | the ten fixed ids (with title, station, twist) |
| `CARRIER` | `{name:'Northwind Air', code:'NWD', mainBase:'MAN'}` |
| Patterns | `FLIGHT_NUMBER_PATTERN` `^NWD[1-9][0-9]{2}$`, `TAIL_PATTERN` `^NW-[A-Z]{3}$`, `IATA_PATTERN`, `HHMM_PATTERN`, `SCENARIO_ID_PATTERN` `^[a-z0-9-]{3,64}$` |

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
  aircraft: {tail NW-XXX, type A319|A320|A321|B737|B738|E190, station IATA, stand?, nextSectors: Sector[]}
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
- Flight numbers (`nextSectors`, `rotation`, `cohorts`) must match `^NWD[1-9][0-9]{2}$`; tails `^NW-[A-Z]{3}$`.
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
| `agent.tool_call` | `{toolCallId, tool, system: ToolSystem, tier, args, presenterTriggered?}` |
| `agent.tool_result` | `{toolCallId, tool, ok, resultPreview ≤500, result?, citations?, deduplicatedFrom?}` |
| `agent.proposal` | `{approvalId, toolCallId, tool, args, summary, reasoning, options?: DecisionOption[], expiresAtMinute?, tier?, unresolvedChecks?, approvalScope?, citations?, dataAsOfMinute?, assumptions?, supersedesApprovalId?}` |
| `approval.decision` | `{approvalId, decision: approve\|edit\|reject, editedArgs?, selectedOptionId?, reason?, decidedBy: Actor}` |
| `approval.invalidated` *(addition)* | `{approvalId, affectedAssumptions: {key, was, now, source?}[], causedBySeq?, role?}` — an assumption of an approved proposal changed |
| `agent.report` | `{role, report: AgentReport}` |
| `agent.aborted` | `{role, reason: iterations\|tool_calls\|tokens\|wall_clock\|budget\|error\|stopped, detail}` |
| `guardrail.blocked` | `{layer: tier\|input_screen\|output_screen\|arg_validation\|ref_validation, tool?, reason, excerpt?, toolCallId?, rule?, authority?, presenterTriggered?}` |
| `twist.requested` | `{twistId?, text?}` — written by the API, drained by the Run Lambda |
| `control.requested` | `{action: pause\|resume\|stop\|set_speed\|demo_forbidden, speed?, tool?}` — written by the API |
| `baseline.action` | `{actor, tool, args, note}` |
| `llm.fallback` | `{from: {provider, model}, to: {provider, model}, reason}` |

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
`RunLimits{maxIterationsPerAgent,maxToolCallsPerRun,maxInputTokensPerRun,wallClockMs,budgetUsd,horizonMin}`
(`DEFAULT_RUN_LIMITS` = 25 / 60 / 200k / 8 min / $2.00 / 180; `EVAL_RUN_LIMITS` = 12 / 40 / 80k / 8 min / $2.00 / 60),
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
  `KnowledgeHit {chunkId, sourceId, url, title, section?, jurisdiction?, date?, collection, text, score}`.
- LLM layer: `LlmProvider {id, complete(LlmRequest) → LlmResponse}`; `LlmRequest {model, system, messages:
  LlmMessage[], tools: LlmToolSpec[], maxTokens, temperature ≤0.2, cacheHints?, signal?, meta?}`;
  `LlmMessage {role: user|assistant, content: (text{cache?} | tool_use{id,name,input} | tool_result{toolUseId,
  content,isError?})[]}`; `LlmResponse {text, toolCalls[{id,name,input}], usage: LlmUsage, stopReason, model, raw?}`;
  `LlmConfig {provider, model, fallback?, temperature, maxTokens, limits}`; `WallClock {now, sleep}`.
- `RunDeps {store, traces, knowledge, llm, clock?, approvalsPolicy?: human|baseline|eval-auto, secrets?, bus?,
  providers?}`; `ExecuteRunInput {runId, deps, signal?}`; `AuthorResult {scenario?, errors?, screening}`.

## 8. API (`src/api.ts`)

| Route | Request | Response |
|---|---|---|
| `GET /scenarios` | – | `{items: ScenarioSummary[]}` |
| `GET /scenarios/{id}` | – | `Scenario` |
| `POST /scenarios/author` | `AuthorScenarioRequest {text ≤8000}` | `{scenario?, errors?, screening}` |
| `POST /runs` | `CreateRunRequest {scenarioId, mode, speed? 1–30, pairedRunId?}` | `{runId}` |
| `GET /runs?limit=` | – | `{items: RunMeta[]}` |
| `GET /runs/{id}` | – | `RunMeta` |
| `GET /runs/{id}/events?after=&limit=` | limit ≤ `MAX_EVENTS_PAGE` (500) | `{events, lastSeq, hasMore}` |
| `POST /runs/{id}/approvals/{approvalId}` | `ApprovalDecisionRequest {decision, editedArgs?, selectedOptionId?, reason?, roleTitle?}` | `{accepted: true, seq}` |
| `POST /runs/{id}/twists` | `TwistRequest {twistId} \| {text ≤2000}` | `{accepted, seq?, screening?}` |
| `POST /runs/{id}/control` | `ControlRequest {action, speed?, tool?}` | `{accepted, seq}` |
| `GET /runs/{id}/systems/{name}` | – | `{system, entities, asOfSeq}` |
| `GET /runs/{id}/export` | – | `{trace: RunEvent[] \| {url}, evidencePack?}` |
| `GET /config` | – | `AppConfig {brand: BrandPack, features {webSearch, liveWeather, narrator, sideBySide}, stations: Station[], limits {maxRunsPerDay, runBudgetUsd, horizonMin, speedMin, speedMax}}` |
| `GET /evals/latest` | – | `EvalReport` |

`API_ROUTES` names every route. Request bodies have TypeBox schemas (`…RequestSchema`, strict) — validate with
`compileSchema(schema)`. Errors: `ApiError {error, code}`. WebSocket: connect with `?token=<JWT>&runId=<id>`;
server → client `WsServerMessage = {kind:'events', runId, events} | {kind:'ping'}`; client may send `{action:'ping'}`.
`WebRuntimeConfig` (`/config.json` next to the SPA): `{apiUrl, wsUrl, auth: {mode:'none'} | {mode:'cognito', region,
userPoolId, clientId, domain, redirectUri}}`.

Records: `RunMeta {runId, scenarioId, scenarioTitle, mode, status, pairedRunId?, createdAt, simMinute, lastSeq, totals,
speed, llm?, updatedAt?, endedAt?, error?}`; `ScenarioSummary {id, title, station, aircraftType, triggerType,
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
interface TraceStore { put(runId, seq: number|string, body, {suffix?}) → key; get(key) }
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
| schema (task 06) | `BrandPack.productName?` (default "Ground Incident Coordination Agent") | product rename; stack ids, package scope, table and bucket names unchanged (ADR 0007) |
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
