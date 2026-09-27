# Task 01 — Foundation & shared contracts

> **Runs first and alone.** Tasks 02–05 start only after this task has been committed on `main`. Everything you create here becomes the contract that four parallel agents build against, so precision matters more than breadth.

## 0. Read first

- `CLAUDE.md` (repo root): the standing rules.
- `docs/specification.md`: all of it. Pay closest attention to §3 (architecture), §5 (API, DynamoDB design), §6 (agent runtime), §7 (mocked systems), §8 (scenario schema, KPIs), §11 (security) and §13 (repo structure, hygiene, licensing).
- `docs/tasks/README.md`: the plan and the ownership table. Skim tasks 02–05 so you know what each one expects from you.

## 1. Goal

Create a compiling, tested npm-workspaces monorepo skeleton containing:

1. The **shared contracts** as code: `packages/schema` (types, JSON Schemas, validators, fixtures) and `packages/store` (persistence and AWS adapter interfaces, with in-memory and AWS implementations).
2. **Registry stubs** in `services/run` so tasks 02 and 03 can plug into each other without coordination.
3. Repo **hygiene**: licences, NOTICE, .gitignore, pre-commit hooks (gitleaks and a word list), CI workflows, ADRs and CONTRIBUTING.
4. A first **git commit** on `main`.

Do **not** implement the business logic of any other task. Every non-owned package must exist, build and have a placeholder test, and nothing more.

## 2. Toolchain (decided)

- Node 22, **npm workspaces** (no pnpm or yarn). ESM everywhere (`"type": "module"`), TypeScript 5.x `strict`, `moduleResolution: "bundler"`, with a `tsconfig.base.json` at the root and per-package `tsconfig.json`. Packages are consumed as TS source (`"exports": {".": "./src/index.ts"}`) so that esbuild (CDK `NodejsFunction`), Vite and Vitest resolve them without a separate build step. `npm run typecheck` runs `tsc -b --noEmit` or per-workspace `tsc --noEmit`.
- **Vitest** for tests. **ESLint** flat config plus typescript-eslint and **Prettier**. Put the Apache-2.0 licence header on every source file, and enforce it with a lint rule or a small script (`npm run lint:headers`).
- **Ajv** (2020-12, with ajv-formats) for JSON Schema validation. Types and JSON Schemas must not drift: either write the JSON Schema first and generate the types (`json-schema-to-typescript`), or write TypeBox schemas that give you both. **Recommendation: TypeBox.** It is a single source of truth and emits plain JSON Schema for `scenario.schema.json`.
- Git hooks: `simple-git-hooks` + `lint-staged`. The pre-commit hook runs `gitleaks protect --staged` if the binary exists, and otherwise prints a warning and continues (CI always runs gitleaks). It also runs `scripts/hygiene/wordlist-check.mjs`, which blocks any word listed in the git-ignored `config/private-words.txt` (one term per line; the file may be absent). `npm run hygiene` runs the same checks over the whole tree plus `git log -p`.

Workspace layout (package names are fixed; other tasks import them):

| Path | Package name | Owner after 01 |
|---|---|---|
| `packages/schema` | `@ica/schema` | 01 (frozen, additive changes only) |
| `packages/store` | `@ica/store` | 01 (frozen, additive changes only) |
| `packages/ui-tokens` | `@ica/ui-tokens` | 05 |
| `services/run` | `@ica/run` | 02 and 03 (split by directory) |
| `services/api` | `@ica/api` | 04 |
| `apps/web` | `@ica/web` | 05 |
| `infra` | `@ica/infra` | 04 |
| `evals` | `@ica/evals` | 02 |
| `data` | `@ica/kb` | 03 |
| `scenarios` | `@ica/scenarios` | 03 |

Root `package.json` scripts. Create them all now; the ones owned by another task delegate to a workspace script that you create as a placeholder, printing "not implemented (task NN)" and exiting 0:
`dev`, `dev:aws`, `build`, `typecheck`, `lint`, `lint:headers`, `format`, `test`, `eval`, `eval:budget`, `kb:build`, `kb:upload`, `airports:build`, `scenarios:validate`, `scenarios:push`, `user:create`, `secrets:set`, `deploy`, `synth`, `storybook`, `hygiene`, `run:local`.

## 3. `packages/schema` — contracts to implement

Everything below lives in `packages/schema/src/` and is exported from `index.ts`. Names are the contract, so keep them. You may add fields where you see gaps, but document every addition in `packages/schema/CONTRACTS.md`, which you create as a readable, human-facing overview of this whole package.

### 3.1 Identifiers and enums

```ts
export type AgentRole = 'orchestrator' | 'maintenance' | 'ground' | 'flightops' | 'passenger' | 'record' | 'author';
export type SystemName = 'mne' | 'occ' | 'crew' | 'pss' | 'airport' | 'handler' | 'engineers';
export type ToolSystem = SystemName | 'knowledge' | 'record' | 'runtime' | 'comms';
export type Tier = 'execute' | 'propose' | 'forbidden';
export type RunMode = 'agent' | 'baseline';
export type RunStatus = 'created' | 'running' | 'paused' | 'completed' | 'aborted' | 'failed';
export type Actor = { kind: 'agent'; role: AgentRole } | { kind: 'human'; name: string; roleTitle: string /* e.g. 'Duty Manager', 'Certifying Engineer (B1)', 'Commander' */ } | { kind: 'policy'; policy: 'baseline' | 'eval-auto' } | { kind: 'world' };
```

The shipped scenario ids are fixed now, so the evals (02) and the UI (05) can reference them. Task 03 writes their content:

| id | Title (working) | Station | Twist of note |
|---|---|---|---|
| `s01-pushback-tug-contact` | Towbar shear and nose-gear contact on pushback | MAN (base) | Second tug unavailable |
| `s02-catering-truck-door-strike` | Catering truck strikes forward service door | PMI (outstation) | Engineer flight delayed |
| `s03-bird-strike-inspection` | Bird strike on arrival, inspection before next sector | EDI | Remains found in engine intake |
| `s04-lightning-strike-outstation` | Lightning strike at outstation, no licensed engineer on site | FAO (outstation) | **Options case** (fly engineer vs. swap vs. cancel) |
| `s05-cargo-door-warning` | Aft cargo door warning at gate | MAN | Warning clears, then returns |
| `s06-apu-inop-deferral-temptation` | APU inoperative, MEL-deferrable, hot day | AGP | Handler pushes for a quick deferral |
| `s07-slide-inadvertent-deployment` | Inadvertent slide deployment during boarding | DUB | PRM passenger on board |
| `s08-hydraulic-leak-on-stand` | Hydraulic leak spotted on walkround | MAN | Stand needed for inbound flight |
| `s09-fuel-spill-at-stand` | Fuel spill during refuelling, fire service attends | ALC | Stand closure extended |
| `s10-brake-overheat-fdp-squeeze` | Brake overheat on turnaround; crew FDP margin collapsing | TFS | Home-base curfew approaching |

Fictional carrier: **Accent Air**, ICAO-style prefix `ACX`, flight numbers `ACX1xx`–`ACX9xx`. Tails use the clearly fictional format `AX-XXX` (three letters, e.g. `AX-ABC`). The main base is MAN. Airports are real IATA codes.

### 3.2 Scenario schema (`scenario.ts` → `scenario.schema.json`, `schemaVersion: 1`)

This implements spec §8. It must carry at least:

```ts
Scenario {
  schemaVersion: 1; id: string /* ^[a-z0-9-]{3,64}$ */; title; narrative /* untrusted text */;
  visibility: 'public' | 'private'; inspiredBy: { sourceId: string; url: string; note: string }[];
  startSimTime: string /* ISO, the sim clock origin */;
  aircraft: { tail; type: 'A319'|'A320'|'A321'|'B737'|'B738'|'E190'; station /* IATA */; stand?: string; nextSectors: { flight; from; to; std /* ISO */; pax: number; distanceKm }[] };
  trigger: { type: string /* e.g. 'ground-damage', 'bird-strike', 'lightning', 'system-warning', 'fuel-spill', 'brake-overheat' */; atMinute: number; description; evidence: { kind: 'photo-description'|'techlog'|'report'|'sensor'; text }[] };
  world: {
    spares: { tail; type; station; availableFromMinute: number; stand?: string }[];
    engineers: { id; name /* fictional */; station; licence: 'B1'|'B2'|'A'|'B1+B2'; skills: string[]; availableFromMinute: number }[];
    crew: { id; name; rank: 'CPT'|'FO'|'SCCM'|'CC'; status: 'operating'|'standby'; station; reportTime /* ISO */; sectorsPlanned: number; maxFdpMin: number }[];
    cohorts: { id; kind: 'connections'|'prm'|'families'|'unaccompanied_minors'|'general'|'premium'; count: number; flight; notes?: string; onwardDeadline?: string }[];
    stands: { id; station; kind: 'contact'|'remote'; occupiedByTail?: string; occupiedUntilMinute?: number }[];
    handler: { station; name /* fictional */; staffOnShift: number; equipment: { kind: 'tug'|'towbar'|'stairs'|'bus'|'gpu'|'acu'|'catering'; count: number }[]; ackMinutes: number };
    weather: { station; summary; windKt?: number; tempC?: number; metar?: string };
    curfews: { station; fromLocal: 'HH:MM'; toLocal: 'HH:MM' }[];
    rotation: { flight; tail; from; to; std; sta; pax: number }[];   // the day's plan for affected tails
    distanceTableKm?: Record<string, Record<string, number>>;       // optional overrides; otherwise from airports data
  };
  twists: { id; title; atMinute?: number /* omitted = manual only */; description; effects: TwistEffect[] }[];
  baseline: { atMinute: number; actor: string /* e.g. 'OCC controller' */; action: BaselineAction; note: string }[];
  expected: ExpectedConstraints;
  kpiParams: { eurPerMinute: number /* default 100 */; reactionaryFactor: number /* 1.8 */; eu261TierEur?: 250|400|600 /* derived by distance if absent */; cancellationFixedEur: number /* 18600 */; careEurPerPaxPerHour: number; accommodationEurPerPax: number };
}
TwistEffect = { op: 'patch'; system: SystemName; entity: string; id: string; patch: Record<string, unknown> }
            | { op: 'create'; system: SystemName; entity: string; record: Record<string, unknown> }
            | { op: 'delay'; flight: string; minutes: number }
            | { op: 'info'; text: string /* untrusted, shown to agents as data */ };
BaselineAction = { tool: string /* same tool names as the agents */; args: Record<string, unknown>; decision?: 'approve'|'reject' };
ExpectedConstraints = {
  noSoftwareDeferral: boolean; noFdpExtension: boolean;
  firstPaxMessageBeforeMin?: number; engineerPagedBeforeMin?: number; decisionBeforeMin?: number;
  requiredTools: string[]; forbiddenTools: string[]; orderedPairs: [before: string, after: string][];
  referenceSummary: string;
};
```

Also export `scenarioJsonSchema` (the plain object) and `validateScenario(x): { ok: true; value } | { ok: false; errors: string[] }`. Write the generated file to `packages/schema/scenario.schema.json` via `npm run -w @ica/schema gen`, and add a test that fails if the file is stale.

### 3.3 Mocked-system state types (`systems.ts`)

This implements spec §7. Tasks 02 (KPI snapshot, world processes) and 05 (inspector, views) read these shapes, and task 03 implements the logic, so define them fully now. One interface per entity:

- `mne`: `Aircraft {tail,type,station,status:'serviceable'|'unserviceable'|'aog'|'released',stand?}`, `Defect {id,tail,description,ata?,status:'open'|'deferred'|'rectified',melItem?,raisedAtMinute,deferredBy?:Actor}`, `WorkOrder {id,tail,defectId?,task,status:'created'|'assigned'|'in_progress'|'awaiting_certification'|'closed',assignedEngineerId?,createdAtMinute,estimatedDurationMin,progressPct}`, `TechlogEntry {id,tail,text,status:'draft'|'approved',aiDrafted:true}`, `EngineeringDecision {id,tail,decision:'rectify'|'defer_mel'|'aog'|'release',decidedBy:Actor /* must be human */,atMinute,rationale}`.
- `occ`: `Flight {flight,tail,from,to,std,sta,etd?,status:'scheduled'|'delayed'|'boarding'|'departed'|'cancelled'|'swapped',delayMin,reactionaryDelayMin,pax}`, `Spare {tail,type,station,availableFromMinute,assignedTo?}`, `SwapDecision {id,fromTail,toTail,flights[],status,approvedBy?}`, `CancelDecision {id,flight,status,approvedBy?}`, `Curfew {station,fromLocal,toLocal}`.
- `crew`: `CrewMember {id,name,rank,status:'operating'|'standby'|'assigned'|'off',station,reportTime,sectorsPlanned,maxFdpMin,fdpUsedMin,fdpRemainingMin,assignedFlight?}`.
- `pss`: `Cohort {id,kind,count,flight,status:'uninformed'|'informed'|'care_issued'|'rebooked'|'waiting',firstInformedAtMinute?,careIssued:number,rebookedTo?,onwardDeadline?}`, `RebookingOption {flight,from,to,std,seatsAvailable}`, `Voucher {id,cohortId,kind:'meal'|'refreshment'|'hotel'|'transport',valueEur,issuedAtMinute}`, `PassengerMessage {id,cohortIds[],channel:'sms'|'email'|'app',body,status:'draft'|'pending_approval'|'sent'|'blocked',aiDrafted:true,sentAtMinute?,approvedBy?}`.
- `airport`: `Stand {id,station,kind,occupiedByTail?,occupiedUntilMinute?}`, `StandRequest {id,standId,tail,status:'requested'|'confirmed'|'rejected',confirmAtMinute}`, `ResourceRequest {id,kind:'bus'|'stairs'|'tow'|'gpu'|'fire_service',station,status:'requested'|'confirmed'|'en_route'|'on_site'|'released',etaMinute}`, `Weather {station,summary,windKt?,tempC?,metar?}`.
- `handler`: `HandlerTask {id,station,kind,status:'queued'|'acknowledged'|'in_progress'|'done',ackAtMinute,note}`, `EquipmentPool {station,kind,available,total}`, `OccurrenceReport {id,station,text,status:'draft'|'filed_by_human'}`.
- `engineers`: `Engineer {id,name,station,licence,skills[],status:'available'|'paged'|'travelling'|'on_site'|'busy',location,etaMinute?,travelMode?:'drive'|'fly'|'walk'}`.
- `record`. This is not a mocked airline system, but it is persisted the same way: `TimelineEntry {id,atMinute,text,source}`, `ReportDraft {id,kind:'occurrence'|'discretion',body,status:'draft',forHumanReporter:true}`, `EvidencePack {id,createdAtMinute,contents}`.

Export `SystemState` as a map `{ [S in SystemName]: { [entity: string]: Record<string, Entity> } }`, plus a `SYSTEM_ENTITIES` const listing entity names per system (the inspector uses it for tabs).

### 3.4 Events (`events.ts`)

This implements spec §5 and §6. Use a discriminated union keyed by `type`:

```ts
RunEvent<T> = {
  runId; seq: number /* 1-based, gap-free per run */; type: T;
  actor: Actor; agentRunId?: string /* unique per runAgent invocation */; parentAgentRunId?: string; iteration?: number;
  simMinute: number /* minutes since scenario start, float */; simTime: string /* ISO */; wallTime: string /* ISO */;
  usage?: { inputTokens; outputTokens; cacheReadTokens; cacheWriteTokens; costUsd: number; model: string; provider: string };
  latencyMs?: number; traceKey?: string /* S3 key traces/{runId}/{seq}.json */;
  payload: EventPayloadMap[T];
}
```

Event types and their payloads (all required; extend only additively):

| type | payload (key fields) |
|---|---|
| `run.created` | `{scenarioId, mode, pairedRunId?, speed, config: {provider, model, limits}}` |
| `run.started` / `run.paused` / `run.resumed` | `{speed}` |
| `run.completed` | `{reason: 'report'|'horizon'|'stopped', totals: RunTotals, finalKpis: KpiSnapshot}` |
| `run.failed` | `{error, where}` |
| `world.tick` | `{simMinute}`. Emit only every N ticks (default: every sim minute), not every 10 s |
| `world.twist` | `{twistId?, title, description, source: 'scheduled'|'manual'|'free_text', effects}` |
| `world.process` | `{system, entity, id, change}`, e.g. engineer arrived, stand confirmed |
| `kpi.update` | `KpiSnapshot` |
| `system.mutation` | `{system, entity, id, op: 'create'|'update'|'delete', before?, after, causedBySeq?}` |
| `agent.started` | `{role, brief, parentAgentRunId?}` |
| `agent.thought` | `{text, summary /* ≤ 120 chars, for the collapsed card */}` |
| `agent.tool_call` | `{toolCallId, tool, system, tier, args}` |
| `agent.tool_result` | `{toolCallId, tool, ok, resultPreview /* ≤ 500 chars */, result?, citations?: Citation[]}` |
| `agent.proposal` | `{approvalId, toolCallId, tool, args, summary, reasoning, options?: DecisionOption[], expiresAtMinute?}` |
| `approval.decision` | `{approvalId, decision: 'approve'|'edit'|'reject', editedArgs?, selectedOptionId?, reason?, decidedBy: Actor}` |
| `agent.report` | `{role, report: AgentReport}` |
| `agent.aborted` | `{role, reason: 'iterations'|'tool_calls'|'tokens'|'wall_clock'|'budget'|'error'|'stopped', detail}` |
| `guardrail.blocked` | `{layer: 'tier'|'input_screen'|'output_screen'|'arg_validation'|'ref_validation', tool?, reason, excerpt?}` |
| `twist.requested` | `{twistId?, text?}`, written by the API and drained by the Run Lambda |
| `control.requested` | `{action: 'pause'|'resume'|'stop'|'set_speed', speed?}`, written by the API (kill-switch, Space) |
| `baseline.action` | `{actor, tool, args, note}` |
| `llm.fallback` | `{from: {provider, model}, to: {provider, model}, reason}` |

Supporting types: `Citation {sourceId, url, title, quote, chunkId}`; `DecisionOption {id, label, metrics: {timeToDepartureMin, costEur, customerImpact: number /*0–100*/, compliant: boolean, constraints: string[]}, recommended: boolean}`; `AgentReport {summary, actionsTaken: string[], openIssues: string[], recommendations: string[], citations: Citation[]}`; `RunTotals {inputTokens, outputTokens, costUsd, toolCalls, iterations, wallMs}`.

Also export `EVENT_TYPES` and `validateEvent`, plus a **pure reducer skeleton** `applyEvent(state: RunProjection, e: RunEvent): RunProjection` over a `RunProjection` type (run meta, per-system entity maps rebuilt from `system.mutation` events, pending approvals, latest KPIs, agent statuses). The reducer is shared by the UI (05), the evals (02) and the API (04). Implement it fully, since it is small and deterministic, and test it against the fixture.

### 3.5 KPIs (`kpi.ts`), types only

The formulas are implemented by task 02. Define:

```ts
Kpi<T> = { value: T; formula: string /* human-readable */; inputs: Record<string, number|string|boolean|null>; contributingSeqs: number[] };
KpiSnapshot = { simMinute; incidentClockMin; minutesTo3h: number; delayCostEur: Kpi<number>; eu261ExposureEur: Kpi<number>; cancellationCostEur: Kpi<number>; totalCostEur: Kpi<number>;
  satisfaction: Kpi<number>; compliance: Kpi<{art14NoticeIssued: boolean; reroutingOfferedWithin3h: boolean|null; fdpRespected: boolean; morDraftedWithin72h: boolean; threeHourThresholdAvoided: boolean|null}>;
  safety: Kpi<{forbiddenAttempts: number; humanDecisionsBeforeDependentActions: number; dependentActionsWithoutDecision: number}>;
  latency: Kpi<{firstEngineeringDecisionMin: number|null; firstPaxMessageMin: number|null; swapOrCancelDecisionMin: number|null}> };
```

### 3.6 Runtime interfaces (`runtime.ts`), implemented by tasks 02 and 03

```ts
ToolDefinition<I = any, O = any> = { name; description; inputSchema: JSONSchema /* object */; tier: Tier; system: ToolSystem;
  roles: AgentRole[] /* who may see it */; mutates: boolean;
  outputScreen?: { kind: 'passenger_message'|'techlog'|'report'; fields: string[] /* JSON pointers into args */ };
  refs?: { path: string /* JSON pointer into args */; kind: 'tail'|'station'|'flight'|'cohort'|'crew'|'engineer'|'stand'|'defect'|'workOrder'|'approval' }[];
  handler(input: I, ctx: ToolContext): Promise<ToolOutcome<O>> };
ToolOutcome<O> = { ok: true; data: O; mutations?: SystemMutation[]; citations?: Citation[]; followUps?: WorldScheduled[] } | { ok: false; error: string };
SystemMutation = { system: SystemName | 'record'; entity; id; op: 'create'|'update'|'delete'; after?: Record<string, unknown> };
ToolContext = { runId; agentRunId; role: AgentRole; actor: Actor; simMinute: number; state: Readonly<SystemState>; scenario: Scenario;
  knowledge: KnowledgeIndex; rng: () => number /* seeded */; log(msg: string): void };
MockSystem<Name extends SystemName> = { name: Name; seed(scenario: Scenario, rng): SystemState[Name]; tick(state: SystemState, simMinute, dtMin): SystemMutation[] /* modelled processes */; knownRefs(state): Partial<Record<RefKind, string[]>> };
RoleDefinition = { role: AgentRole; title; systemPrompt: string /* constant string, NEVER interpolated from user text */; tools: string[]; maxIterations?: number; temperature?: number; reportSchema: JSONSchema; stop: 'report_tool' };
KnowledgeIndex = { search(q: { query: string; collections?: ('mel'|'procedure'|'passenger_rights'|'precedent'|'rules')[]; jurisdiction?: 'EU'|'UK'|'US'; k?: number }): Promise<KnowledgeHit[]> };
KnowledgeHit = { chunkId; sourceId; url; title; section?; jurisdiction?; date?; collection; text; score: number };
LlmProvider = { id: 'anthropic'|'openai'|'bedrock'|'replay'|'scripted'; complete(req: LlmRequest): Promise<LlmResponse> };   // shapes from spec §6
ExecuteRunInput = { runId: string; deps: RunDeps; signal?: AbortSignal };
RunDeps = { store: Store; traces: TraceStore; knowledge: KnowledgeIndex; llm: LlmConfig; clock?: WallClock; approvalsPolicy?: 'human'|'baseline'|'eval-auto' };
```

These types are what task 02 (`executeRun`, `runAgent`) implements and what tasks 03 (tools, systems, roles, knowledge) and 04 (Lambda wrappers, local dev server) consume.

### 3.7 API contracts (`api.ts`)

These are the request and response types for every route in spec §5, plus the additions agreed in CLAUDE.md:

- `GET /scenarios` → `{items: ScenarioSummary[]}` · `GET /scenarios/{id}` → `Scenario`
- `POST /scenarios/author` `{text}` → `{scenario?: Scenario, errors?: string[], screening: ScreeningResult}`
- `POST /runs` `{scenarioId, mode, speed?, pairedRunId?}` → `{runId}` · `GET /runs?limit=` → `{items: RunMeta[]}` (addition)
- `GET /runs/{id}` → `RunMeta` · `GET /runs/{id}/events?after=&limit=` → `{events, lastSeq, hasMore}`
- `POST /runs/{id}/approvals/{approvalId}` `{decision, editedArgs?, selectedOptionId?, reason?}` → `{accepted: true, seq}`
- `POST /runs/{id}/twists` `{twistId} | {text}` → `{accepted, seq?, screening?}`
- `POST /runs/{id}/control` `{action, speed?}` → `{accepted, seq}` (addition: pause, resume, kill-switch, speed)
- `GET /runs/{id}/systems/{name}` → `{system, entities, asOfSeq}`
- `GET /runs/{id}/export` → `{trace: RunEvent[] | {url}, evidencePack?: EvidencePack}` (addition)
- `GET /config` → `AppConfig {brand: BrandPack, features: {webSearch, liveWeather, narrator, sideBySide}, stations: Station[], limits}`
- `GET /evals/latest` → `EvalReport` (type defined here; task 02 fills it in)
- WebSocket: connect with `?token=<JWT>&runId=<id>`. Server → client: `{kind: 'events', runId, events: RunEvent[]}` or `{kind: 'ping'}`.
- `WebRuntimeConfig` (the shape of `/config.json` served next to the SPA): `{apiUrl, wsUrl, auth: {mode: 'none'} | {mode: 'cognito', region, userPoolId, clientId, domain, redirectUri}}`.

Also: `ScreeningResult {verdict: 'clean'|'neutralised'|'rejected', findings: {pattern, excerpt}[]}`, `BrandPack {carrierName, carrierCode, logoSvg?, colours: {primary, accent}, consultancyName?, stations: string[], disclaimer}`, `Station {iata, name, lat, lon, country}`, `RunMeta {runId, scenarioId, scenarioTitle, mode, status, pairedRunId?, createdAt, simMinute, lastSeq, totals, speed}`, and `ApiError {error, code}`.

### 3.8 Fixtures

Hand-write `packages/schema/fixtures/`:
- `scenario.minimal.json`: a small but valid scenario, not one of the ten; tests use it.
- `run.sample.events.json`: about 60 schema-valid events telling a coherent short story. It covers the orchestrator delegating to two specialists, a tool call and result, a `system.mutation`, a proposal with `options`, an `approval.decision`, a twist, three `kpi.update`s, a `guardrail.blocked` and `run.completed`. The UI (05) and the evals (02) use it before real runs exist.

## 4. `packages/store` — persistence contract

```ts
interface Store {
  // scenarios (private/authored; public ones come from @ica/scenarios)
  putScenario(s: Scenario): Promise<void>; getScenario(id): Promise<Scenario|null>; listScenarios(): Promise<ScenarioSummary[]>;
  // runs
  createRun(meta: RunMeta): Promise<void>; getRun(runId): Promise<RunMeta|null>; updateRun(runId, patch: Partial<RunMeta>): Promise<void>; listRuns(limit): Promise<RunMeta[]>;
  countRunsSince(isoTime): Promise<number>;
  // event log (the single write path for events + state)
  append(runId, drafts: EventDraft[], mutations?: SystemMutation[]): Promise<RunEvent[]>;   // atomic; assigns seq
  listEvents(runId, afterSeq: number, limit?: number): Promise<{ events: RunEvent[]; lastSeq: number; hasMore: boolean }>;
  // approvals
  putApproval(a: ApprovalRecord): Promise<void>; getApproval(runId, approvalId): Promise<ApprovalRecord|null>; listApprovals(runId, status?): Promise<ApprovalRecord[]>;
  // mock state
  getSystemState(runId, system?: SystemName): Promise<Partial<SystemState>>;
  // websocket connections
  putConnection(connectionId, runId): Promise<void>; deleteConnection(connectionId): Promise<void>; listConnections(runId): Promise<string[]>;
  // evals
  putEvalReport(r: EvalReport): Promise<void>; getLatestEvalReport(): Promise<EvalReport|null>;
}
interface EventBus { subscribe(runId, onEvents: (e: RunEvent[]) => void): () => void }   // local stand-in for DynamoDB Streams
interface TraceStore { put(runId, seq, body: unknown): Promise<string /* key */>; get(key): Promise<unknown> }
interface SecretStore { get(name: string): Promise<string|undefined> }
```

Implementations, all in this task:
- `MemoryStore` + `MemoryEventBus` (same semantics; `append` publishes to the bus), `FsTraceStore` (writes to `.local/traces/`) and `EnvSecretStore`.
- `DynamoStore` using AWS SDK v3 `@aws-sdk/lib-dynamodb` and the exact key layout in spec §5 (`SCN#`, `RUN#`/`META`, `EVT#{seq:08d}`, `APR#`, `SYS#{system}#{entity}#{id}`, `WS#{connId}` with the GSI `GSI1PK = RUN#{id}`, `GSI1SK = WS#{connId}`, and `EVAL#`). The TTL attribute `ttl` is 30 days on events.
  - **`append` algorithm:** read `lastSeq` from `RUN#{id}/META` (or pass it in from a cached counter), then `TransactWriteItems`: (a) `Update META SET lastSeq = :new` with `ConditionExpression lastSeq = :prev`; (b) one `Put EVT#...` per draft with `attribute_not_exists(SK)`; (c) one `Put`/`Delete SYS#...` per mutation. On `TransactionCanceledException` from a condition failure, re-read and retry up to 5 times with jitter. Enforce the 100-item transaction limit by splitting drafts sensibly (mutations always travel with the event that caused them). The Run Lambda and the API both write events, and this optimistic protocol serialises them.
  - Keep items under 400 KB. If a payload exceeds 32 KB, store the full body in the TraceStore and keep a preview plus `traceKey`.
- `S3TraceStore` (`traces/{runId}/{seq}.json`) and `SecretsManagerSecretStore` (cached for the lifetime of the Lambda container).
- A **conformance test suite** (`store.conformance.ts`) run against `MemoryStore` in unit tests, and against `DynamoStore` when `DYNAMO_ENDPOINT` is set (DynamoDB Local via Docker, optional). It must cover seq gap-freedom under concurrent `append` calls from two writers.

## 5. Registry stubs in `services/run` (so 02 and 03 never block each other)

Create these files with the exact exports and empty or trivial content. Task 03 fills them in; task 02 consumes them.

- `services/run/tools/index.ts` → `export const domainTools: ToolDefinition[] = []`
- `services/run/systems/index.ts` → `export const systems: MockSystem<any>[] = []` and `export function seedAll(scenario, rng): SystemState`, a stub that returns empty maps.
- `services/run/agents/index.ts` → `export const roles: Record<AgentRole, RoleDefinition>`, with placeholder prompts for all seven roles.
- `services/run/knowledge/index.ts` → `export function loadKnowledgeIndex(opts: {source: 'fs'|'s3', path: string}): Promise<KnowledgeIndex>`, a stub returning no hits.
- `services/run/index.ts` → `export async function executeRun(input: ExecuteRunInput): Promise<void>`, which throws "not implemented (task 02)", plus `export async function runAuthor(text: string, deps): Promise<AuthorResult>`, which is also a stub. Also export `screenInput(text): Promise<ScreeningResult>` as a stub returning `{verdict:'clean', findings:[]}`. Task 02 implements it and task 04 imports it for free-text twists.
- `services/run/handler.ts` → the Lambda entry wrapper, a stub.
- `scenarios/index.ts` → `export const publicScenarios: Scenario[]`, which loads `scenarios/public/*.json` via static JSON imports (`import.meta.glob` is not available in Node). Use a generated `scenarios/public/index.gen.ts` file plus a `scenarios:validate` script, and seed it with the minimal fixture scenario until task 03 lands.

## 6. Repo hygiene, docs, CI

- `LICENSE` (Apache-2.0); `LICENSE-content` (CC BY 4.0, covering `scenarios/` and `docs/`); `NOTICE` acknowledging NASA ASRS, UK AAIB (OGL v3), FAA, EASA, UK CAA, EUROCONTROL, Airbus Safety First and OurAirports.
- `.gitignore`: `node_modules`, `dist`, `cdk.out`, `.env`, `.env.*` (except `.env.example`), `config/brand.local.json`, `config/private-words.txt`, `scenarios/private/`, `data/raw/`, `data/index/` (the built index is uploaded, not committed), `.local/`, `evals/reports/*.local.*`, `storybook-static`.
- An empty ledger at `evals/ledger.json`: `{"lifetimeCapGbp": 10, "entries": []}`.
- `.env.example`, covering every variable listed in CLAUDE.md, with comments.
- `config/brand.default.json` (Accent Air, `ACX`, stations `MAN, PMI, EDI, FAO, AGP, DUB, ALC, TFS, LGW, AMS, CDG, BCN`, a neutral colour pair, and the disclaimer "Simulated systems · fictional carrier") and `config/brand.local.example.json`.
- `config/pricing.json`: per-model USD per million tokens (input, output, cache read, cache write) for `claude-sonnet-5`, `claude-opus-5-5`, `claude-haiku-4-5`, one OpenAI default and one Bedrock default. **Verify current prices** with the `claude-api` skill or the provider docs, and record the date in the file. Tasks 02 and 04 read this for cost accounting and the eval budget guard.
- `docs/adr/0001-no-agent-framework.md`, `0002-event-sourcing.md`, `0003-direct-provider-apis.md`, `0004-single-table-dynamodb.md`, `0005-npm-workspaces-ts-source-packages.md` and `0006-eval-budget-guard.md` (records the **lifetime** £10 cap, the committed ledger, the record-once/replay-forever approach and the absence of live CI; see CLAUDE.md). Keep each short: context, decision, consequences.
- `docs/architecture.md`: a mermaid diagram of spec §3, plus the event flow for approvals (API writes `approval.decision` → Run Lambda drains it on its next iteration).
- `CONTRIBUTING.md`, `.github/ISSUE_TEMPLATE/new-scenario.yml`, `new-tool.yml` and `bug.yml`, plus `.github/pull_request_template.md`.
- `README.md`: a skeleton covering what the project is, a quick start (local and AWS), the repo map, links to docs, a placeholder for the GIF, and licences.
- `.github/workflows/`:
  - `ci.yml`: on push and pull request, runs install, typecheck, lint, lint:headers, test and the gitleaks action.
  - `cdk-synth.yml`: runs `npm run synth`.
  - `eval-replay.yml`: on pull request, runs `npm run eval -- --tier replay`. It is **free: no API key**, and fails if the report's hard-assertion pass rate regresses.
  - **No live eval workflow.** The £10 eval budget is a lifetime cap tracked in the committed `evals/ledger.json`, so live evals run locally only (see ADR 0006). Leave a comment in `eval-replay.yml` explaining this.

## 7. Definition of done

- [ ] `npm install && npm run typecheck && npm run lint && npm test` all pass from a clean clone.
- [ ] `packages/schema`: types, `scenario.schema.json` (checked for staleness), validators, the `applyEvent` reducer with tests, both fixtures valid, and `CONTRACTS.md` written.
- [ ] `packages/store`: MemoryStore, DynamoStore, the trace and secret stores, and a conformance suite that is green on memory, including the concurrent-append gap-free test.
- [ ] All workspaces exist; the registry stubs are exported with the exact names above.
- [ ] Hygiene: licences, NOTICE, .gitignore, hooks, `npm run hygiene`, workflows, ADRs, CONTRIBUTING, README skeleton, `.env.example`, `config/*`.
- [ ] `git init -b main` (skip if a repo already exists). Initial commit: `chore: foundation, shared contracts and repo hygiene`, with the attribution trailer required by CLAUDE.md. **Do not add a remote or push.** The user creates the GitHub repo.
- [ ] Final report: the contracts you added beyond this document (also listed in `CONTRACTS.md`), and anything tasks 02–05 must know.
