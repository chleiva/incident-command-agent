/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Typed client for every route in `@ica/schema` `API_ROUTES`. Retries with exponential backoff on network errors
 * only (never on HTTP errors, which are returned as `ApiRequestError`).
 */
import type {
  AppConfig,
  AuthorDraft,
  ApprovalDecisionRequest,
  ApprovalDecisionResponse,
  AuthorScenarioResponse,
  ControlRequest,
  ControlResponse,
  CreateRunRequest,
  CreateRunResponse,
  EvalReport,
  ExportResponse,
  ListEventsResponse,
  ListRunsResponse,
  ListScenariosResponse,
  RunAuditLlmResponse,
  RunAuditResponse,
  RunMeta,
  Scenario,
  StateSystemName,
  SystemStateResponse,
  TwistRequest,
  TwistResponse,
} from '@ica/schema/browser';
import type { Transport } from './transport';

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

export interface ApiClientOptions {
  baseUrl: string;
  transport: Transport;
  getToken?: () => Promise<string | null> | string | null;
  /** Attempts after the first, on network errors only. */
  retries?: number;
  backoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export type ApiClient = ReturnType<typeof createApiClient>;

const enc = encodeURIComponent;

function query(params: Record<string, string | undefined>): string {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${enc(v!)}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

export function createApiClient(opts: ApiClientOptions) {
  const retries = opts.retries ?? 3;
  const backoff = opts.backoffMs ?? 300;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const base = opts.baseUrl.replace(/\/$/, '');

  async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const token = opts.getToken ? await opts.getToken() : null;
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (token) headers.authorization = `Bearer ${token}`;
    let attempt = 0;
    for (;;) {
      let res: Response;
      try {
        res = await opts.transport.fetch(`${base}${path}`, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (err) {
        if (attempt >= retries) throw err;
        await sleep(backoff * 2 ** attempt);
        attempt += 1;
        continue;
      }
      const text = await res.text();
      const json = text ? (JSON.parse(text) as unknown) : undefined;
      if (!res.ok) {
        const e = (json ?? {}) as { error?: string; code?: string };
        throw new ApiRequestError(
          e.error ?? `HTTP ${res.status}`,
          res.status,
          e.code ?? `http_${res.status}`,
        );
      }
      return json as T;
    }
  }

  return {
    listScenarios: () => request<ListScenariosResponse>('GET', '/scenarios'),
    getScenario: (id: string) => request<Scenario>('GET', `/scenarios/${enc(id)}`),
    /** 202 `{draftId, status: 'pending', screening}`: poll `getAuthorDraft` (see `authorAndWait`). */
    authorScenario: (text: string) => request<AuthorScenarioResponse>('POST', '/scenarios/author', { text }),
    getAuthorDraft: (draftId: string) => request<AuthorDraft>('GET', `/scenarios/drafts/${enc(draftId)}`),
    createRun: (req: CreateRunRequest) => request<CreateRunResponse>('POST', '/runs', req),
    listRuns: (limit = 10) => request<ListRunsResponse>('GET', `/runs?limit=${limit}`),
    getRun: (runId: string) => request<RunMeta>('GET', `/runs/${enc(runId)}`),
    listEvents: (runId: string, after = 0, limit?: number) =>
      request<ListEventsResponse>(
        'GET',
        `/runs/${enc(runId)}/events?after=${after}${limit ? `&limit=${limit}` : ''}`,
      ),
    decideApproval: (runId: string, approvalId: string, req: ApprovalDecisionRequest) =>
      request<ApprovalDecisionResponse>('POST', `/runs/${enc(runId)}/approvals/${enc(approvalId)}`, req),
    injectTwist: (runId: string, req: TwistRequest) =>
      request<TwistResponse>('POST', `/runs/${enc(runId)}/twists`, req),
    control: (runId: string, req: ControlRequest) =>
      request<ControlResponse>('POST', `/runs/${enc(runId)}/control`, req),
    getSystemState: (runId: string, name: StateSystemName) =>
      request<SystemStateResponse>('GET', `/runs/${enc(runId)}/systems/${enc(name)}`),
    exportRun: (runId: string) => request<ExportResponse>('GET', `/runs/${enc(runId)}/export`),
    getConfig: () => request<AppConfig>('GET', '/config'),
    getLatestEval: () => request<EvalReport>('GET', '/evals/latest'),
    /** Audit logs: one page of entries (`nextCursor` for the next). */
    getRunAudit: (runId: string, cursor?: string, limit?: number) =>
      request<RunAuditResponse>(
        'GET',
        `/runs/${enc(runId)}/audit${query({ cursor, limit: limit === undefined ? undefined : String(limit) })}`,
      ),
    /** Audit logs: one stored LLM trace (or a short-lived URL to it when large). */
    getRunAuditLlm: (runId: string, key: string) =>
      request<RunAuditLlmResponse>('GET', `/runs/${enc(runId)}/audit/llm?key=${enc(key)}`),
  };
}

export interface AuthorWaitOptions {
  /** Called on every poll with the elapsed milliseconds (progress UI). */
  onProgress?: (elapsedMs: number) => void;
  pollMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Training "write a scenario": start the Scenario Author (202 + draft id), then poll the draft until it is ready or
 * failed. Resolves with the same shape the synchronous endpoint used to return.
 */
export async function authorAndWait(
  api: Pick<ApiClient, 'authorScenario' | 'getAuthorDraft'>,
  text: string,
  opts: AuthorWaitOptions = {},
): Promise<AuthorScenarioResponse> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? (() => Date.now());
  const started = now();
  const first = await api.authorScenario(text);
  if (!first.draftId || first.scenario || first.status === 'ready' || first.status === 'failed') return first;
  const timeoutMs = opts.timeoutMs ?? 6 * 60_000;
  for (;;) {
    opts.onProgress?.(now() - started);
    await sleep(opts.pollMs ?? 2_000);
    const d = await api.getAuthorDraft(first.draftId);
    if (d.status === 'ready' || d.status === 'failed') {
      return {
        draftId: d.draftId,
        status: d.status,
        screening: d.screening ?? first.screening,
        ...(d.scenario ? { scenario: d.scenario } : {}),
        ...(d.errors?.length ? { errors: d.errors } : {}),
      };
    }
    if (now() - started > timeoutMs)
      return {
        draftId: first.draftId,
        status: 'failed',
        screening: first.screening,
        errors: ['The Scenario Author did not finish in time.'],
      };
  }
}
