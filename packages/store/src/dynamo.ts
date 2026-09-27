/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * DynamoDB single-table Store (spec §5). See keys.ts for the item layout.
 *
 * `append` protocol (optimistic, gap-free):
 *   1. read lastSeq from RUN#{id}/META (or use the cached counter);
 *   2. TransactWriteItems: Update META SET lastSeq = :new IF lastSeq = :prev; Put EVT# per event
 *      IF attribute_not_exists(SK); Put/Delete SYS# per mutation;
 *   3. on a condition failure (another writer won) re-read and retry, up to 5 times with jitter.
 * Mutations always travel in the same transaction as their `system.mutation` event. Batches larger than one
 * transaction (100 items) are split into several transactions, each atomic, in order.
 */
import { DynamoDBClient, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type QueryCommandInput,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import {
  RunNotFoundError,
  summariseScenario,
  type ApprovalRecord,
  type ApprovalPatch,
  type ApprovalStatus,
  type EvalReport,
  type EventDraft,
  type EventPage,
  type RunEvent,
  type RunMeta,
  type Scenario,
  type ScenarioSummary,
  type StateSystemName,
  type Store,
  type SystemMutation,
  type SystemState,
  type TraceStore,
} from '@ica/schema';
import {
  EVENT_TTL_DAYS,
  GSI1,
  GSI1_EVALS,
  GSI1_RUNS,
  GSI1_SCENARIOS,
  MAX_INLINE_EVENT_BYTES,
  MAX_TRANSACTION_ITEMS,
  META,
  approvalSk,
  connectionPk,
  evalPk,
  eventSk,
  parseSysSk,
  runPk,
  scenarioPk,
  sysSk,
} from './keys';
import { emptyStateFor, groupMutations, sleep, toEvent } from './util';

type Item = Record<string, any>;
type TransactItem = NonNullable<TransactWriteCommandInput['TransactItems']>[number];

export interface DynamoStoreOptions {
  tableName: string;
  /** Inject a client (tests). Otherwise one is created from region/endpoint. */
  client?: Pick<DynamoDBDocumentClient, 'send'>;
  region?: string;
  /** e.g. http://localhost:8000 for DynamoDB Local. */
  endpoint?: string;
  /** Where oversized event payloads go. Without it, events over 32 KB are stored inline (up to ~350 KB). */
  traces?: TraceStore;
  maxRetries?: number;
  now?: () => Date;
}

/** Convert a stored event row (or a stream NEW_IMAGE after `unmarshall`) back into a RunEvent. */
export async function itemToEvent(item: Item, traces?: TraceStore): Promise<RunEvent> {
  const event = item.event as RunEvent;
  if (item.payloadKey && traces) {
    const full = (await traces.get(item.payloadKey as string)) as RunEvent;
    return full;
  }
  return event;
}

function isConditionFailure(err: unknown): boolean {
  if (
    !(err instanceof TransactionCanceledException) &&
    (err as { name?: string })?.name !== 'TransactionCanceledException'
  ) {
    return false;
  }
  const reasons = (err as TransactionCanceledException).CancellationReasons;
  if (!reasons) return true;
  return reasons.some((r) => r?.Code === 'ConditionalCheckFailed' || r?.Code === 'TransactionConflict');
}

export class DynamoStore implements Store {
  private readonly doc: Pick<DynamoDBDocumentClient, 'send'>;
  private readonly table: string;
  private readonly traces?: TraceStore;
  private readonly maxRetries: number;
  private readonly now: () => Date;
  /** Cached lastSeq per run (optimistic; a stale value just costs one retry). */
  private readonly seqCache = new Map<string, number>();

  constructor(opts: DynamoStoreOptions) {
    this.table = opts.tableName;
    this.traces = opts.traces;
    this.maxRetries = opts.maxRetries ?? 5;
    this.now = opts.now ?? (() => new Date());
    this.doc =
      opts.client ??
      DynamoDBDocumentClient.from(new DynamoDBClient({ region: opts.region, endpoint: opts.endpoint }), {
        marshallOptions: { removeUndefinedValues: true, convertClassInstanceToMap: false },
      });
  }

  private iso = () => this.now().toISOString();

  private async queryAll(input: Omit<QueryCommandInput, 'TableName'>): Promise<Item[]> {
    const out: Item[] = [];
    let ExclusiveStartKey: Record<string, any> | undefined;
    do {
      const res = await this.doc.send(
        new QueryCommand({ TableName: this.table, ...input, ExclusiveStartKey }),
      );
      out.push(...((res.Items as Item[]) ?? []));
      ExclusiveStartKey = res.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return out;
  }

  // ------------------------------------------------------------------ scenarios
  async putScenario(s: Scenario): Promise<void> {
    await this.doc.send(
      new PutCommand({
        TableName: this.table,
        Item: {
          PK: scenarioPk(s.id),
          SK: META,
          GSI1PK: GSI1_SCENARIOS,
          GSI1SK: s.id,
          visibility: s.visibility,
          schemaVersion: s.schemaVersion,
          title: s.title,
          body: s,
        },
      }),
    );
  }
  async getScenario(id: string): Promise<Scenario | null> {
    const res = await this.doc.send(
      new GetCommand({ TableName: this.table, Key: { PK: scenarioPk(id), SK: META } }),
    );
    return (res.Item?.body as Scenario) ?? null;
  }
  async listScenarios(): Promise<ScenarioSummary[]> {
    const items = await this.queryAll({
      IndexName: GSI1,
      KeyConditionExpression: 'GSI1PK = :p',
      ExpressionAttributeValues: { ':p': GSI1_SCENARIOS },
    });
    return items.map((i) => summariseScenario(i.body as Scenario));
  }

  // ------------------------------------------------------------------ runs
  private metaToItem(meta: RunMeta): Item {
    return {
      ...meta,
      PK: runPk(meta.runId),
      SK: META,
      GSI1PK: GSI1_RUNS,
      GSI1SK: `${meta.createdAt}#${meta.runId}`,
    };
  }
  private itemToMeta(i: Item): RunMeta {
    const { PK: _pk, SK: _sk, GSI1PK: _g, GSI1SK: _gs, ...meta } = i;
    return meta as RunMeta;
  }

  async createRun(meta: RunMeta): Promise<void> {
    await this.doc.send(
      new PutCommand({
        TableName: this.table,
        Item: this.metaToItem({ ...meta, lastSeq: 0 }),
        ConditionExpression: 'attribute_not_exists(PK)',
      }),
    );
    this.seqCache.set(meta.runId, 0);
  }
  async getRun(runId: string): Promise<RunMeta | null> {
    const res = await this.doc.send(
      new GetCommand({ TableName: this.table, Key: { PK: runPk(runId), SK: META }, ConsistentRead: true }),
    );
    return res.Item ? this.itemToMeta(res.Item) : null;
  }
  async updateRun(runId: string, patch: Partial<RunMeta>): Promise<void> {
    const { lastSeq: _l, runId: _r, createdAt: _c, ...rest } = patch;
    const fields = { ...rest, updatedAt: rest.updatedAt ?? this.iso() } as Record<string, unknown>;
    const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
    const names: Record<string, string> = {};
    const values: Record<string, unknown> = {};
    const sets = entries.map(([k, v], i) => {
      names[`#k${i}`] = k;
      values[`:v${i}`] = v;
      return `#k${i} = :v${i}`;
    });
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { PK: runPk(runId), SK: META },
          UpdateExpression: `SET ${sets.join(', ')}`,
          ConditionExpression: 'attribute_exists(PK)',
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
        }),
      );
    } catch (err) {
      if ((err as { name?: string }).name === 'ConditionalCheckFailedException')
        throw new RunNotFoundError(runId);
      throw err;
    }
  }
  async listRuns(limit: number): Promise<RunMeta[]> {
    const res = await this.doc.send(
      new QueryCommand({
        TableName: this.table,
        IndexName: GSI1,
        KeyConditionExpression: 'GSI1PK = :p',
        ExpressionAttributeValues: { ':p': GSI1_RUNS },
        ScanIndexForward: false,
        Limit: limit,
      }),
    );
    return ((res.Items as Item[]) ?? []).map((i) => this.itemToMeta(i));
  }
  async countRunsSince(isoTime: string): Promise<number> {
    let count = 0;
    let ExclusiveStartKey: Record<string, any> | undefined;
    do {
      const res = await this.doc.send(
        new QueryCommand({
          TableName: this.table,
          IndexName: GSI1,
          KeyConditionExpression: 'GSI1PK = :p AND GSI1SK >= :t',
          ExpressionAttributeValues: { ':p': GSI1_RUNS, ':t': isoTime },
          Select: 'COUNT',
          ExclusiveStartKey,
        }),
      );
      count += res.Count ?? 0;
      ExclusiveStartKey = res.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return count;
  }

  // ------------------------------------------------------------------ events
  private async readLastSeq(runId: string): Promise<number> {
    const res = await this.doc.send(
      new GetCommand({
        TableName: this.table,
        Key: { PK: runPk(runId), SK: META },
        ProjectionExpression: 'lastSeq',
        ConsistentRead: true,
      }),
    );
    if (!res.Item) throw new RunNotFoundError(runId);
    return Number(res.Item.lastSeq ?? 0);
  }

  private async eventItem(e: RunEvent, ttl: number): Promise<Item> {
    const base = { PK: runPk(e.runId), SK: eventSk(e.seq), type: e.type, seq: e.seq, ttl };
    const size = Buffer.byteLength(JSON.stringify(e));
    if (size <= MAX_INLINE_EVENT_BYTES || !this.traces) return { ...base, event: e };
    const payloadKey = await this.traces.put(e.runId, e.seq, e, { suffix: '.payload' });
    const preview = JSON.stringify(e.payload).slice(0, 1000);
    return { ...base, payloadKey, event: { ...e, payload: { _truncated: true, preview } } };
  }

  /** Split into transactions of ≤ 100 items (1 META update + events + mutations). */
  private plan(drafts: EventDraft[], mutations: SystemMutation[]) {
    const groups = groupMutations(drafts, mutations);
    const cap = MAX_TRANSACTION_ITEMS - 1;
    const chunks: { drafts: EventDraft[]; mutations: SystemMutation[] }[] = [];
    let cur = { drafts: [] as EventDraft[], mutations: [] as SystemMutation[] };
    for (const g of groups) {
      const size = (g.draft ? 1 : 0) + g.mutations.length;
      if (size > cap) throw new Error(`one event carries ${g.mutations.length} mutations; max ${cap - 1}`);
      if (cur.drafts.length + cur.mutations.length + size > cap) {
        chunks.push(cur);
        cur = { drafts: [], mutations: [] };
      }
      if (g.draft) cur.drafts.push(g.draft);
      cur.mutations.push(...g.mutations);
    }
    if (cur.drafts.length || cur.mutations.length) chunks.push(cur);
    return chunks;
  }

  async append(runId: string, drafts: EventDraft[], mutations: SystemMutation[] = []): Promise<RunEvent[]> {
    if (!drafts.length && !mutations.length) {
      await this.readLastSeq(runId);
      return [];
    }
    const out: RunEvent[] = [];
    for (const chunk of this.plan(drafts, mutations)) out.push(...(await this.appendChunk(runId, chunk)));
    return out;
  }

  private async appendChunk(
    runId: string,
    chunk: { drafts: EventDraft[]; mutations: SystemMutation[] },
  ): Promise<RunEvent[]> {
    for (let attempt = 0; ; attempt++) {
      const prev = this.seqCache.get(runId) ?? (await this.readLastSeq(runId));
      const wall = this.iso();
      const events = chunk.drafts.map((d, i) => toEvent(runId, prev + i + 1, d, () => wall));
      const next = prev + events.length;
      const ttl = Math.floor(this.now().getTime() / 1000) + EVENT_TTL_DAYS * 86_400;
      const lastSim = events.at(-1)?.simMinute;

      const items: TransactItem[] = [
        {
          Update: {
            TableName: this.table,
            Key: { PK: runPk(runId), SK: META },
            UpdateExpression:
              lastSim === undefined
                ? 'SET lastSeq = :next, updatedAt = :now'
                : 'SET lastSeq = :next, updatedAt = :now, simMinute = :sim',
            ConditionExpression: 'attribute_exists(PK) AND lastSeq = :prev',
            ExpressionAttributeValues: {
              ':next': next,
              ':prev': prev,
              ':now': wall,
              ...(lastSim === undefined ? {} : { ':sim': lastSim }),
            },
          },
        },
      ];
      for (const e of events) {
        items.push({
          Put: {
            TableName: this.table,
            Item: await this.eventItem(e, ttl),
            ConditionExpression: 'attribute_not_exists(SK)',
          },
        });
      }
      for (const m of chunk.mutations) {
        const Key = { PK: runPk(runId), SK: sysSk(m.system, m.entity, m.id) };
        items.push(
          m.op === 'delete'
            ? { Delete: { TableName: this.table, Key } }
            : {
                Put: {
                  TableName: this.table,
                  Item: { ...Key, system: m.system, entity: m.entity, id: m.id, data: m.after ?? {} },
                },
              },
        );
      }

      try {
        await this.doc.send(new TransactWriteCommand({ TransactItems: items }));
        this.seqCache.set(runId, next);
        return events;
      } catch (err) {
        this.seqCache.delete(runId);
        if (!isConditionFailure(err) || attempt >= this.maxRetries) throw err;
        await sleep(10 + Math.random() * 40 * 2 ** attempt);
      }
    }
  }

  async listEvents(runId: string, afterSeq: number, limit = 500): Promise<EventPage> {
    const res = await this.doc.send(
      new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: 'PK = :pk AND SK BETWEEN :from AND :to',
        ExpressionAttributeValues: {
          ':pk': runPk(runId),
          ':from': eventSk(afterSeq + 1),
          ':to': eventSk(99_999_999),
        },
        Limit: limit + 1,
        ConsistentRead: true,
      }),
    );
    const items = (res.Items as Item[]) ?? [];
    const page = items.slice(0, limit);
    const events = await Promise.all(page.map((i) => itemToEvent(i, this.traces)));
    const meta = await this.getRun(runId);
    return { events, lastSeq: meta?.lastSeq ?? 0, hasMore: items.length > limit || !!res.LastEvaluatedKey };
  }

  // ------------------------------------------------------------------ approvals
  async putApproval(a: ApprovalRecord): Promise<void> {
    await this.doc.send(
      new PutCommand({
        TableName: this.table,
        Item: { PK: runPk(a.runId), SK: approvalSk(a.approvalId), status: a.status, record: a },
      }),
    );
  }
  async getApproval(runId: string, approvalId: string): Promise<ApprovalRecord | null> {
    const res = await this.doc.send(
      new GetCommand({
        TableName: this.table,
        Key: { PK: runPk(runId), SK: approvalSk(approvalId) },
        ConsistentRead: true,
      }),
    );
    return (res.Item?.record as ApprovalRecord) ?? null;
  }
  async decideApproval(
    runId: string,
    approvalId: string,
    expectedStatus: ApprovalStatus,
    patch: ApprovalPatch,
  ): Promise<boolean> {
    const names: Record<string, string> = { '#s': 'status', '#r': 'record' };
    const values: Record<string, unknown> = { ':expected': expectedStatus };
    const sets: string[] = [];
    const removes: string[] = [];
    Object.entries(patch).forEach(([k, v], i) => {
      names[`#k${i}`] = k;
      if (v === undefined) return removes.push(`#r.#k${i}`);
      values[`:v${i}`] = v;
      sets.push(`#r.#k${i} = :v${i}`);
      if (k === 'status') sets.push(`#s = :v${i}`); // the top-level copy used for filtering
    });
    if (!sets.length && !removes.length)
      return (await this.getApproval(runId, approvalId))?.status === expectedStatus;
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { PK: runPk(runId), SK: approvalSk(approvalId) },
          UpdateExpression: [
            sets.length ? `SET ${sets.join(', ')}` : '',
            removes.length ? `REMOVE ${removes.join(', ')}` : '',
          ]
            .filter(Boolean)
            .join(' '),
          ConditionExpression: 'attribute_exists(PK) AND #s = :expected',
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
        }),
      );
      return true;
    } catch (err) {
      if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return false;
      throw err;
    }
  }
  async listApprovals(runId: string, status?: ApprovalStatus): Promise<ApprovalRecord[]> {
    const items = await this.queryAll({
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :p)',
      ExpressionAttributeValues: { ':pk': runPk(runId), ':p': 'APR#' },
      ConsistentRead: true,
    });
    return items
      .map((i) => i.record as ApprovalRecord)
      .filter((a) => !status || a.status === status)
      .sort((a, b) => a.proposalSeq - b.proposalSeq);
  }

  // ------------------------------------------------------------------ mock state
  async getSystemState(runId: string, system?: StateSystemName): Promise<Partial<SystemState>> {
    const items = await this.queryAll({
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :p)',
      ExpressionAttributeValues: { ':pk': runPk(runId), ':p': system ? `SYS#${system}#` : 'SYS#' },
      ConsistentRead: true,
    });
    const out = emptyStateFor(system);
    for (const i of items) {
      const k = parseSysSk(i.SK as string);
      if (!k) continue;
      ((out[k.system] ??= {})[k.entity] ??= {})[k.id] = i.data as Record<string, unknown>;
    }
    return out as unknown as Partial<SystemState>;
  }

  // ------------------------------------------------------------------ connections
  async putConnection(connectionId: string, runId: string): Promise<void> {
    await this.doc.send(
      new PutCommand({
        TableName: this.table,
        Item: {
          PK: connectionPk(connectionId),
          SK: runPk(runId),
          GSI1PK: runPk(runId),
          GSI1SK: connectionPk(connectionId),
          connectionId,
          runId,
          ttl: Math.floor(this.now().getTime() / 1000) + 86_400,
        },
      }),
    );
  }
  async deleteConnection(connectionId: string): Promise<void> {
    const items = await this.queryAll({
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': connectionPk(connectionId) },
    });
    for (const i of items) {
      await this.doc.send(new DeleteCommand({ TableName: this.table, Key: { PK: i.PK, SK: i.SK } }));
    }
  }
  async listConnections(runId: string): Promise<string[]> {
    const items = await this.queryAll({
      IndexName: GSI1,
      KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :p)',
      ExpressionAttributeValues: { ':pk': runPk(runId), ':p': 'WS#' },
    });
    return items.map((i) => i.connectionId as string).sort();
  }

  // ------------------------------------------------------------------ evals
  async putEvalReport(r: EvalReport): Promise<void> {
    await this.doc.send(
      new PutCommand({
        TableName: this.table,
        Item: { PK: evalPk(r.id), SK: META, GSI1PK: GSI1_EVALS, GSI1SK: `${r.createdAt}#${r.id}`, report: r },
      }),
    );
  }
  async getLatestEvalReport(): Promise<EvalReport | null> {
    const res = await this.doc.send(
      new QueryCommand({
        TableName: this.table,
        IndexName: GSI1,
        KeyConditionExpression: 'GSI1PK = :p',
        ExpressionAttributeValues: { ':p': GSI1_EVALS },
        ScanIndexForward: false,
        Limit: 1,
      }),
    );
    return ((res.Items as Item[] | undefined)?.[0]?.report as EvalReport) ?? null;
  }
}
