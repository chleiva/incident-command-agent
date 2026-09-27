/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Runtime interfaces implemented by task 02 (runtime, llm) and task 03 (tools, systems, roles, knowledge), and
 * consumed by task 04 (Lambda wrappers, local dev server).
 */
import type { Citation, RunLimits, ScreeningResult } from './common';
import type { EventDraft, RunEventBase } from './events';
import type {
  Actor,
  AgentRole,
  Jurisdiction,
  KnowledgeCollection,
  ProviderId,
  RefKind,
  StateSystemName,
  SystemName,
  Tier,
  ToolSystem,
} from './ids';
import type { EventBus, SecretStore, Store, TraceStore } from './persistence';
import type { KpiSnapshot } from './kpi';
import type { Scenario } from './scenario';
import type { SystemState } from './systems';

/** A JSON Schema object (e.g. a TypeBox schema or a plain object literal). */
export type JSONSchema = { type?: string; [keyword: string]: unknown };

/** A change to persisted mock state. `after` is the FULL entity after the change; omitted for delete. */
export interface SystemMutation {
  system: StateSystemName;
  entity: string;
  id: string;
  op: 'create' | 'update' | 'delete';
  after?: Record<string, unknown>;
  /** Addition: the entity before the change (copied into the system.mutation event). */
  before?: Record<string, unknown>;
}

/** Something a tool schedules for later sim time (e.g. a stand confirmation). Applied by the world engine. */
export interface WorldScheduled {
  atMinute: number;
  /** Short description for the `world.process` event, e.g. "stand 12 confirmed". */
  description: string;
  mutations: SystemMutation[];
}

export type ToolOutcome<O = unknown> =
  | { ok: true; data: O; mutations?: SystemMutation[]; citations?: Citation[]; followUps?: WorldScheduled[] }
  | {
      ok: false;
      error: string;
      /**
       * Addition (demo review 2): structured detail of a failure (e.g. `page_engineer`: who could not be paged, why,
       * and the available alternatives). Sent to the model with the error and recorded as `agent.tool_result.result`.
       */
      data?: unknown;
    };

export interface KnowledgeHit {
  chunkId: string;
  sourceId: string;
  url: string;
  title: string;
  section?: string;
  jurisdiction?: Jurisdiction;
  date?: string;
  collection: KnowledgeCollection;
  /** Verbatim chunk text (quotes are substrings of it). */
  text: string;
  /** Fused retrieval score (reciprocal rank fusion of BM25 and vector ranks). */
  score: number;
  /** The logical document (MEL item, rule sub-paragraph, article, report); hits are collapsed per docId. */
  docId?: string;
  /** Structural context header (`source › section path › jurisdiction › date` …); never quoted. */
  header?: string;
  /** Cohere Rerank relevance (0–1) when the reranker ordered this hit. */
  rerankScore?: number;
}

export interface KnowledgeQuery {
  query: string;
  collections?: KnowledgeCollection[];
  jurisdiction?: Jurisdiction;
  k?: number;
}

export interface KnowledgeIndex {
  search(q: KnowledgeQuery): Promise<KnowledgeHit[]>;
}

export interface ToolContext {
  runId: string;
  agentRunId: string;
  role: AgentRole;
  actor: Actor;
  simMinute: number;
  state: Readonly<SystemState>;
  scenario: Scenario;
  knowledge: KnowledgeIndex;
  /** Seeded, deterministic. */
  rng: () => number;
  log(msg: string): void;
  /**
   * Addition (task 03): when the runtime executes a `propose`-tier tool after an `approval.decision`, the deciding
   * actor (`decidedBy`). Domain handlers record it as the approver (e.g. `SwapDecision.approvedBy`,
   * `EngineeringDecision.decidedBy`) and enforce human-only rules with it. Absent for `execute`-tier calls.
   */
  approvedBy?: Actor;
  /**
   * Addition (integration): the latest KPI snapshot computed by the world engine (read-only), when one exists.
   * `export_evidence_pack` attaches it to the pack.
   */
  kpis?: KpiSnapshot;
  /**
   * Addition (demo review 2): this agent run's earlier calls of `tool` (oldest first; the current call excluded),
   * read from the event log. Lets a tool refuse an immediate retry of a call that just failed.
   */
  priorCalls?: (tool: string) => PriorToolCall[];
}

/** One earlier tool call of the same agent run (see `ToolContext.priorCalls`). */
export interface PriorToolCall {
  toolCallId: string;
  args: Record<string, unknown>;
  ok: boolean;
  /** Sim minute of the call. */
  atMinute: number;
  /** The recorded result data (a failure's `data` included), when any. */
  result?: unknown;
}

export interface ToolRef {
  /** JSON pointer into args, e.g. '/tail'. */
  path: string;
  kind: RefKind;
}

export interface ToolDefinition<I = any, O = any> {
  name: string;
  /** Written for the model: when to use it and what it returns. */
  description: string;
  /** Strict object schema (`additionalProperties: false`). */
  inputSchema: JSONSchema;
  tier: Tier;
  system: ToolSystem;
  /** Roles that may see/call it. */
  roles: AgentRole[];
  mutates: boolean;
  outputScreen?: { kind: 'passenger_message' | 'techlog' | 'report'; fields: string[] };
  refs?: ToolRef[];
  /**
   * Addition (task 06), propose tier: exactly what approving this proposal authorises (shown on the decision card).
   * `approvalExclusions` lists what it does not authorise.
   */
  approvalScope?: string;
  approvalExclusions?: string[];
  /** Addition (task 06), propose tier: checks that are typically still open when this is proposed. */
  defaultUnresolvedChecks?: string[];
  /**
   * Addition (task 06): JSON pointer of the client-generated idempotency key (e.g. '/requestId'). A repeat call with
   * a key that already succeeded returns the original result with no new mutation (and no new proposal).
   */
  idempotencyKey?: string;
  /**
   * Addition (live run 2): JSON pointers of free-text fields the tool itself splits when they exceed the schema's
   * `maxLength` (e.g. `append_timeline` `/text` → sequential entries). The runtime passes such a value through
   * uncut instead of truncating it; every other validation still applies.
   */
  splitOverlong?: string[];
  handler(input: I, ctx: ToolContext): Promise<ToolOutcome<O>>;
}

export interface MockSystem<Name extends SystemName = SystemName> {
  name: Name;
  seed(scenario: Scenario, rng: () => number): SystemState[Name];
  /** Modelled processes (engineer travel, stand confirmation, repair progress…). Pure. */
  tick(state: SystemState, simMinute: number, dtMin: number): SystemMutation[];
  /** Ids agents may reference, for ref validation. */
  knownRefs(state: SystemState): Partial<Record<RefKind, string[]>>;
}

export interface RoleDefinition {
  role: AgentRole;
  title: string;
  /** Constant string. NEVER interpolated from user or scenario text. The runtime prepends its data preamble. */
  systemPrompt: string;
  /** Domain tool names (runtime tools like `report`/`delegate` are added by the runtime). */
  tools: string[];
  maxIterations?: number;
  temperature?: number;
  /** JSON Schema of the role's report (extends AgentReport). */
  reportSchema: JSONSchema;
  stop: 'report_tool';
}

// ------------------------------------------------------------------------------------------------ LLM layer
export interface LlmTextBlock {
  type: 'text';
  text: string;
  /** Cache breakpoint hint (Anthropic `cache_control`). */
  cache?: boolean;
}
export interface LlmToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}
export interface LlmToolResultBlock {
  type: 'tool_result';
  toolUseId: string;
  /** Already wrapped as `<tool_result source=…>` by the runtime. */
  content: string;
  isError?: boolean;
}
export type LlmContentBlock = LlmTextBlock | LlmToolUseBlock | LlmToolResultBlock;

/**
 * Addition: the provider's native assistant content (e.g. Anthropic `thinking` blocks that must be echoed back
 * unchanged in tool-use loops). Adapters use it only when `provider` and `model` match the current request.
 */
export interface LlmProviderContent {
  provider: ProviderId;
  model: string;
  content: unknown[];
}

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: LlmContentBlock[];
  /** Addition: see `LlmProviderContent`. */
  providerContent?: LlmProviderContent;
}

export interface LlmToolSpec {
  name: string;
  description: string;
  inputSchema: JSONSchema;
}

export interface LlmRequest {
  model: string;
  system: string;
  messages: LlmMessage[];
  tools: LlmToolSpec[];
  maxTokens: number;
  /** ≤ 0.2 (NFR-03). */
  temperature: number;
  /** `messages` (addition): a moving cache breakpoint on the last message (incremental conversation caching). */
  cacheHints?: { system?: boolean; tools?: boolean; messages?: boolean };
  signal?: AbortSignal;
  /** For replay keys, traces and logs. */
  meta?: { runId: string; agentRunId: string; role: AgentRole; iteration: number; agentPath?: string };
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export type LlmStopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'refusal' | 'other';

export interface LlmResponse {
  text: string;
  toolCalls: { id: string; name: string; input: Record<string, unknown> }[];
  usage: LlmUsage;
  stopReason: LlmStopReason;
  model: string;
  raw?: unknown;
  /** Addition: native assistant content to round-trip in the next request (see `LlmProviderContent`). */
  providerContent?: LlmProviderContent;
}

export interface LlmProvider {
  id: ProviderId;
  complete(req: LlmRequest): Promise<LlmResponse>;
}

export interface LlmConfig {
  provider: ProviderId;
  model: string;
  fallback?: { provider: ProviderId; model: string };
  temperature: number;
  maxTokens: number;
  limits: RunLimits;
}

export interface WallClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

// ------------------------------------------------------------------------------------------------ run entry points
export interface RunDeps {
  store: Store;
  traces: TraceStore;
  knowledge: KnowledgeIndex;
  llm: LlmConfig;
  clock?: WallClock;
  approvalsPolicy?: 'human' | 'baseline' | 'eval-auto';
  /**
   * Addition: the simulation safety net for the `human` policy. An approval still pending after this much REAL
   * (wall-clock) time is approved by `{kind:'policy', policy:'simulation-auto'}` through the conditional decide path
   * (never twice). Absent = `DEFAULT_SIM_AUTO_APPROVE_AFTER_MS` (0 = OFF since the demo review: agent runs wait
   * for a person); > 0 turns it on. Not applied to baseline or eval-auto (they decide by policy immediately).
   */
  simAutoApproveAfterMs?: number;
  /** Addition: secrets for provider keys (Lambda: Secrets Manager; local: env). */
  secrets?: SecretStore;
  /** Addition: local event bus, so blocked agents can subscribe instead of polling. */
  bus?: EventBus;
  /**
   * Addition (self-recovery): schedule a resume of a run that failed (or ran out of Lambda time with work left).
   * Absent = no resume (the run fails as before).
   */
  scheduleResume?: (req: RunResumeRequest) => Promise<void>;
  /** Addition: inject providers directly (tests: scripted/replay). Keyed by provider id. */
  providers?: Partial<Record<ProviderId, LlmProvider>>;
}

/**
 * Addition (async authoring): prepare the run's (flight-context, template) scenario from the duty manager's free text
 * before the world starts. The text was screened by the API; it is data for the Author, never instructions.
 */
export interface AuthoringRequest {
  text: string;
  /** The incident type's label, for the fallback notice ("running the standard … scenario"). */
  label?: string;
}

/** Addition (self-recovery): schedule a fresh invocation that resumes `runId` (Run Lambda: async self-invoke). */
export interface RunResumeRequest {
  runId: string;
  attempt: number;
  reason: string;
}

/** Addition (self-recovery): at most this many resumes per run; then `run.failed` as before. */
export const MAX_RUN_RESUMES = 2;

/** Addition (self-recovery): `AbortSignal.reason` the Run Lambda uses when it is about to time out. */
export const LAMBDA_TIMEOUT_ABORT = 'lambda_timeout';

export interface ExecuteRunInput {
  runId: string;
  deps: RunDeps;
  signal?: AbortSignal;
  /** Addition (self-recovery): resume this run (attempt ≥ 1) from its event log instead of starting it. */
  resume?: { attempt: number };
  /** Addition (async authoring): present on the invocation of the run that authors (see `RunMeta.preparing`). */
  authoring?: AuthoringRequest;
}

export interface AuthorResult {
  scenario?: Scenario;
  errors?: string[];
  screening: ScreeningResult;
}

/** Build the `system.mutation` event draft that must accompany a persisted mutation. */
export function mutationDraft(
  m: SystemMutation,
  envelope: Omit<RunEventBase, 'runId' | 'seq' | 'wallTime'> & { wallTime?: string },
  causedBySeq?: number,
): EventDraft<'system.mutation'> {
  const payload: EventDraft<'system.mutation'>['payload'] = {
    system: m.system,
    entity: m.entity,
    id: m.id,
    op: m.op,
  };
  if (m.before !== undefined) payload.before = m.before;
  if (m.after !== undefined) payload.after = m.after;
  if (causedBySeq !== undefined) payload.causedBySeq = causedBySeq;
  return { ...envelope, type: 'system.mutation', payload } as EventDraft<'system.mutation'>;
}

/**
 * Addition: default of `RunDeps.simAutoApproveAfterMs`. **0 = off** (demo review 2026-09-27: an agent run's
 * approvals wait for a person; the server never approves on its own unless `SIM_AUTO_APPROVE_AFTER_MS` > 0).
 */
export const DEFAULT_SIM_AUTO_APPROVE_AFTER_MS = 0;

/** `SIM_AUTO_APPROVE_AFTER_MS` (ms; 0 = off) → `RunDeps.simAutoApproveAfterMs`; invalid or unset → the default. */
export function simAutoApproveAfterMsFromEnv(env: Record<string, string | undefined>): number {
  const raw = env.SIM_AUTO_APPROVE_AFTER_MS?.trim();
  if (!raw) return DEFAULT_SIM_AUTO_APPROVE_AFTER_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_SIM_AUTO_APPROVE_AFTER_MS;
}
