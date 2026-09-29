/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  CreateTableCommand,
  DynamoDBClient,
  ResourceInUseException,
  TransactionCanceledException,
} from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import { mutationDraft } from '@ica/schema';
import { DynamoStore, MemoryTraceStore, itemToEvent } from './index';
import { makeRunMeta, runStoreConformance, tickDraft } from './store.conformance';

type Cmd = { constructor: { name: string }; input: any };

/** Minimal fake DocumentClient: records commands, returns canned responses. */
function fakeClient(handler: (cmd: Cmd) => any) {
  const sent: Cmd[] = [];
  return {
    sent,
    client: {
      send: async (cmd: Cmd) => {
        sent.push(cmd);
        return handler(cmd);
      },
    } as any,
  };
}

/** The (PK, SK) of one TransactWriteItems entry. */
function txKey(item: any): string {
  const op = item.Put ?? item.Delete ?? item.Update ?? item.ConditionCheck;
  const k = op.Item ?? op.Key;
  return `${k.PK}|${k.SK}`;
}

/**
 * Fake DocumentClient that enforces DynamoDB's transaction invariant exactly like AWS: a TransactWriteItems with two
 * operations on one item is rejected with a ValidationException (live 2026-09-27: both S01 runs died on it).
 */
function awsLikeClient(start = 0) {
  let lastSeq = start;
  const rows = new Map<string, any>();
  return fakeClient((cmd) => {
    if (cmd.constructor.name === 'GetCommand') return { Item: { lastSeq } };
    if (cmd.constructor.name === 'TransactWriteCommand') {
      const items = cmd.input.TransactItems as any[];
      const keys = items.map(txKey);
      if (new Set(keys).size !== keys.length) {
        throw Object.assign(new Error('Transaction request cannot include multiple operations on one item'), {
          name: 'ValidationException',
        });
      }
      for (const i of items) {
        if (i.Put) rows.set(txKey(i), i.Put.Item);
        if (i.Delete) rows.delete(txKey(i));
      }
      lastSeq += items.filter((i) => i.Put?.Item?.SK?.startsWith('EVT#')).length;
    }
    return {};
  });
}

describe('DynamoStore (unit, fake client)', () => {
  it('the AWS-like fake rejects two operations on one item (guards the test double itself)', async () => {
    const { client } = awsLikeClient();
    await expect(
      client.send({
        constructor: { name: 'TransactWriteCommand' },
        input: {
          TransactItems: [
            { Put: { Item: { PK: 'RUN#r1', SK: 'SYS#occ#flights#ACX211' } } },
            { Delete: { Key: { PK: 'RUN#r1', SK: 'SYS#occ#flights#ACX211' } } },
          ],
        },
      }),
    ).rejects.toThrow(/multiple operations on one item/);
  });

  it('coalesces mutations per SYS# key within one transaction (last write wins; events stay as emitted)', async () => {
    const { sent, client } = awsLikeClient(10);
    const store = new DynamoStore({ tableName: 't', client });
    const env = { actor: { kind: 'world' as const }, simMinute: 66, simTime: '2026-06-12T06:36:00.000Z' };
    const f1 = {
      system: 'occ' as const,
      entity: 'flights',
      id: 'ACX211',
      op: 'update' as const,
      after: { flight: 'ACX211', tail: 'AX-MAK', status: 'swapped' },
    };
    const f2 = { ...f1, after: { ...f1.after, etd: '2026-06-12T07:40:00Z', delayMin: 20 } };
    const wo = { system: 'mne' as const, entity: 'workOrders', id: 'wo-1', op: 'create' as const, after: {} };
    const woDel = { ...wo, op: 'delete' as const, after: undefined };
    const muts = [f1, wo, f2, woDel];
    const events = await store.append(
      'r1',
      muts.map((m) => mutationDraft(m, env)),
      muts,
    );
    expect(events.map((e) => e.seq)).toEqual([11, 12, 13, 14]);
    const tx = sent.find((c) => c.constructor.name === 'TransactWriteCommand')!.input.TransactItems;
    const sys = tx.filter((i: any) => txKey(i).includes('|SYS#'));
    expect(sys).toHaveLength(2);
    expect(sys.find((i: any) => i.Put)!.Put.Item.data).toEqual(f2.after); // last write wins
    expect(sys.find((i: any) => i.Delete)!.Delete.Key.SK).toBe('SYS#mne#workOrders#wo-1'); // delete after put
    // every system.mutation event is still written, in order
    expect(tx.filter((i: any) => i.Put?.Item?.type === 'system.mutation')).toHaveLength(4);
  });

  it('dedupes by key per transaction when a large batch is split', async () => {
    const { sent, client } = awsLikeClient();
    const store = new DynamoStore({ tableName: 't', client });
    const env = { actor: { kind: 'world' as const }, simMinute: 0, simTime: '2026-06-12T05:30:00.000Z' };
    const muts = Array.from({ length: 120 }, (_, i) => ({
      system: 'pss' as const,
      entity: 'cohorts',
      id: `c-${i % 7}`,
      op: 'update' as const,
      after: { id: `c-${i % 7}`, n: i },
    }));
    await store.append(
      'r1',
      muts.map((m) => mutationDraft(m, env)),
      muts,
    );
    const txs = sent
      .filter((c) => c.constructor.name === 'TransactWriteCommand')
      .map((c) => c.input.TransactItems);
    expect(txs.length).toBeGreaterThan(1);
    for (const items of txs) {
      const keys = items.map(txKey);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it('appends with the optimistic seq protocol and exact key layout', async () => {
    const { sent, client } = fakeClient((cmd) =>
      cmd.constructor.name === 'GetCommand' ? { Item: { lastSeq: 7 } } : {},
    );
    const store = new DynamoStore({ tableName: 't', client, now: () => new Date('2026-06-12T06:00:00Z') });
    const m = {
      system: 'mne' as const,
      entity: 'workOrders',
      id: 'wo-1',
      op: 'create' as const,
      after: { id: 'wo-1' },
    };
    const env = { actor: { kind: 'world' as const }, simMinute: 5, simTime: '2026-06-12T05:35:00.000Z' };
    const events = await store.append('r1', [tickDraft(5), mutationDraft(m, env)], [m]);
    expect(events.map((e) => e.seq)).toEqual([8, 9]);

    const tx = sent.find((c) => c.constructor.name === 'TransactWriteCommand')!.input.TransactItems;
    expect(tx[0].Update.Key).toEqual({ PK: 'RUN#r1', SK: 'META' });
    expect(tx[0].Update.ConditionExpression).toBe('attribute_exists(PK) AND lastSeq = :prev');
    expect(tx[0].Update.ExpressionAttributeValues).toMatchObject({ ':prev': 7, ':next': 9, ':sim': 5 });
    expect(tx[1].Put.Item).toMatchObject({ PK: 'RUN#r1', SK: 'EVT#00000008', type: 'world.tick', seq: 8 });
    expect(tx[1].Put.ConditionExpression).toBe('attribute_not_exists(SK)');
    expect(tx[1].Put.Item.ttl).toBe(Math.floor(Date.parse('2026-06-12T06:00:00Z') / 1000) + 30 * 86400);
    expect(tx[2].Put.Item.SK).toBe('EVT#00000009');
    expect(tx[3].Put.Item).toMatchObject({
      PK: 'RUN#r1',
      SK: 'SYS#mne#workOrders#wo-1',
      data: { id: 'wo-1' },
    });

    // cached counter: the next append does not re-read META
    const gets = sent.filter((c) => c.constructor.name === 'GetCommand').length;
    await store.append('r1', [tickDraft(6)]);
    expect(sent.filter((c) => c.constructor.name === 'GetCommand').length).toBe(gets);
  });

  it('re-reads lastSeq and retries when another writer wins', async () => {
    let lastSeq = 3;
    let failures = 1;
    const { sent, client } = fakeClient((cmd) => {
      if (cmd.constructor.name === 'GetCommand') return { Item: { lastSeq } };
      if (cmd.constructor.name === 'TransactWriteCommand') {
        if (failures-- > 0) {
          lastSeq = 5; // the other writer appended 2 events
          throw new TransactionCanceledException({
            message: 'cancelled',
            $metadata: {},
            CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
          });
        }
      }
      return {};
    });
    const store = new DynamoStore({ tableName: 't', client });
    const [e] = await store.append('r1', [tickDraft(1)]);
    expect(e.seq).toBe(6);
    expect(sent.filter((c) => c.constructor.name === 'TransactWriteCommand')).toHaveLength(2);
  });

  it('splits large batches into ≤100-item transactions keeping mutations with their event', async () => {
    let lastSeq = 0;
    const { sent, client } = fakeClient((cmd) => {
      if (cmd.constructor.name === 'GetCommand') return { Item: { lastSeq } };
      if (cmd.constructor.name === 'TransactWriteCommand') {
        lastSeq += cmd.input.TransactItems.filter((i: any) => i.Put?.Item?.SK?.startsWith('EVT#')).length;
      }
      return {};
    });
    const store = new DynamoStore({ tableName: 't', client });
    const env = { actor: { kind: 'world' as const }, simMinute: 0, simTime: '2026-06-12T05:30:00.000Z' };
    const muts = Array.from({ length: 80 }, (_, i) => ({
      system: 'pss' as const,
      entity: 'cohorts',
      id: `c-${i}`,
      op: 'create' as const,
      after: { id: `c-${i}` },
    }));
    const events = await store.append(
      'r1',
      muts.map((m) => mutationDraft(m, env)),
      muts,
    );
    expect(events.map((e) => e.seq)).toEqual(Array.from({ length: 80 }, (_, i) => i + 1));
    const txs = sent
      .filter((c) => c.constructor.name === 'TransactWriteCommand')
      .map((c) => c.input.TransactItems);
    expect(txs.length).toBe(2);
    for (const items of txs) {
      expect(items.length).toBeLessThanOrEqual(100);
      const evtIds = items
        .filter((i: any) => i.Put?.Item?.type === 'system.mutation')
        .map((i: any) => i.Put.Item.event.payload.id);
      const sysIds = items
        .filter((i: any) => i.Put?.Item?.SK?.startsWith('SYS#'))
        .map((i: any) => i.Put.Item.id);
      expect(sysIds).toEqual(evtIds);
    }
  });

  it('offloads payloads over 32 KB to the TraceStore and rehydrates them', async () => {
    const traces = new MemoryTraceStore();
    const { sent, client } = fakeClient((cmd) =>
      cmd.constructor.name === 'GetCommand' ? { Item: { lastSeq: 0 } } : {},
    );
    const store = new DynamoStore({ tableName: 't', client, traces });
    const big = {
      type: 'agent.thought' as const,
      actor: { kind: 'agent' as const, role: 'orchestrator' as const },
      simMinute: 1,
      simTime: '2026-06-12T05:31:00.000Z',
      payload: { text: 'x'.repeat(40_000), summary: 'long' },
    };
    const [e] = await store.append('r1', [big]);
    const put = sent.find((c) => c.constructor.name === 'TransactWriteCommand')!.input.TransactItems[1].Put
      .Item;
    expect(put.payloadKey).toBe('traces/r1/1.payload.json');
    expect(put.event.payload._truncated).toBe(true);
    expect(await itemToEvent(put, traces)).toEqual(e);
  });
});

const endpoint = process.env.DYNAMO_ENDPOINT;

const localClient = () =>
  new DynamoDBClient({
    endpoint,
    region: 'local',
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  });

async function createTable(tableName: string) {
  const ddb = localClient();
  try {
    await ddb.send(
      new CreateTableCommand({
        TableName: tableName,
        BillingMode: 'PAY_PER_REQUEST',
        AttributeDefinitions: [
          { AttributeName: 'PK', AttributeType: 'S' },
          { AttributeName: 'SK', AttributeType: 'S' },
          { AttributeName: 'GSI1PK', AttributeType: 'S' },
          { AttributeName: 'GSI1SK', AttributeType: 'S' },
        ],
        KeySchema: [
          { AttributeName: 'PK', KeyType: 'HASH' },
          { AttributeName: 'SK', KeyType: 'RANGE' },
        ],
        GlobalSecondaryIndexes: [
          {
            IndexName: 'GSI1',
            KeySchema: [
              { AttributeName: 'GSI1PK', KeyType: 'HASH' },
              { AttributeName: 'GSI1SK', KeyType: 'RANGE' },
            ],
            Projection: { ProjectionType: 'ALL' },
          },
        ],
      }),
    );
  } catch (err) {
    if (!(err instanceof ResourceInUseException)) throw err;
  }
}

describe('DynamoStore.decideApproval (unit, fake client)', () => {
  it('updates with a ConditionExpression on status and reports a lost race as false', async () => {
    let fail = false;
    const { sent, client } = fakeClient(() => {
      if (fail) throw Object.assign(new Error('conditional'), { name: 'ConditionalCheckFailedException' });
      return {};
    });
    const store = new DynamoStore({ tableName: 't', client, traces: new MemoryTraceStore() });
    expect(await store.decideApproval('r1', 'apr-1', 'pending', { status: 'approved' })).toBe(true);
    const cmd = sent[0];
    expect(cmd.constructor.name).toBe('UpdateCommand');
    expect(cmd.input.Key).toEqual({ PK: 'RUN#r1', SK: 'APR#apr-1' });
    expect(cmd.input.ConditionExpression).toBe('attribute_exists(PK) AND #s = :expected');
    expect(cmd.input.ExpressionAttributeValues[':expected']).toBe('pending');
    expect(cmd.input.UpdateExpression).toContain('#s = :v0');
    expect(cmd.input.UpdateExpression).toContain('#r.#k0 = :v0');
    fail = true;
    expect(await store.decideApproval('r1', 'apr-1', 'pending', { status: 'rejected' })).toBe(false);
  });
});

describe('DynamoStore.claimResume (unit, fake client)', () => {
  it('claims with a conditional update on resumeAttempt and reports a lost claim as false', async () => {
    let fail = false;
    const { sent, client } = fakeClient((cmd) => {
      if (cmd.constructor.name === 'GetCommand') return { Item: { runId: 'r1', resumeAttempt: 1 } };
      if (fail) throw Object.assign(new Error('conditional'), { name: 'ConditionalCheckFailedException' });
      return {};
    });
    const store = new DynamoStore({ tableName: 't', client, retry: { sleep: async () => undefined } });
    expect(await store.claimResume('r1', 1)).toBe(true);
    const cmd = sent[0];
    expect(cmd.constructor.name).toBe('UpdateCommand');
    expect(cmd.input.Key).toEqual({ PK: 'RUN#r1', SK: 'META' });
    expect(cmd.input.ConditionExpression).toBe(
      'attribute_exists(PK) AND (attribute_not_exists(resumeAttempt) OR resumeAttempt < :a)',
    );
    fail = true;
    expect(await store.claimResume('r1', 1)).toBe(false);
  });
  it('claimContinuation uses its own counter (continuationAttempt)', async () => {
    const { sent, client } = fakeClient(() => ({}));
    const store = new DynamoStore({ tableName: 't', client, retry: { sleep: async () => undefined } });
    expect(await store.claimContinuation('r1', 3)).toBe(true);
    expect(sent[0].input.UpdateExpression).toBe('SET continuationAttempt = :a, updatedAt = :now');
    expect(sent[0].input.ConditionExpression).toBe(
      'attribute_exists(PK) AND (attribute_not_exists(continuationAttempt) OR continuationAttempt < :a)',
    );
  });
});

describe.skipIf(!endpoint)('DynamoStore against DynamoDB Local (DYNAMO_ENDPOINT)', () => {
  const tableName = `ica-conformance-${Date.now()}`;
  let ready: Promise<void> | null = null;
  runStoreConformance('DynamoStore', async () => {
    ready ??= createTable(tableName);
    await ready;
    const client = DynamoDBDocumentClient.from(localClient(), {
      marshallOptions: { removeUndefinedValues: true },
    });
    return new DynamoStore({ tableName, client, traces: new MemoryTraceStore() });
  });
  it('uses a fresh run meta helper', () => expect(makeRunMeta().lastSeq).toBe(0));
});
