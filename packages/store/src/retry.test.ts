/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { describe, expect, it } from 'vitest';
import { mutationDraft } from '@ica/schema';
import { DynamoStore, S3TraceStore, SecretsManagerSecretStore } from './index';
import { backoffMs, classifyError, isTransientError, withRetry } from './retry';
import { tickDraft } from './store.conformance';

const named = (name: string, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(name), { name, ...extra });
const noSleep = { sleep: async () => undefined };

describe('classifyError', () => {
  it.each([
    ['ThrottlingException'],
    ['ProvisionedThroughputExceededException'],
    ['RequestLimitExceeded'],
    ['InternalServerError'],
    ['ServiceUnavailable'],
    ['TimeoutError'],
    ['SlowDown'],
  ])('%s is transient', (name) => expect(classifyError(named(name))).toBe('transient'));

  it('5xx and 429 are transient; 4xx is not', () => {
    expect(isTransientError(named('Whatever', { $metadata: { httpStatusCode: 503 } }))).toBe(true);
    expect(isTransientError(named('Whatever', { $metadata: { httpStatusCode: 429 } }))).toBe(true);
    expect(isTransientError(named('Whatever', { $metadata: { httpStatusCode: 400 } }))).toBe(false);
  });

  it('network errors (codes, messages, causes) are transient', () => {
    expect(isTransientError(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toBe(true);
    expect(isTransientError(new Error('socket hang up'))).toBe(true);
    expect(isTransientError(new Error('outer', { cause: named('ETIMEDOUT') }))).toBe(true);
  });

  it('a transaction cancelled only by TransactionConflict is transient; a condition failure is not', () => {
    const tx = (codes: string[]) =>
      new TransactionCanceledException({
        message: 'cancelled',
        $metadata: {},
        CancellationReasons: codes.map((Code) => ({ Code })),
      });
    expect(classifyError(tx(['None', 'TransactionConflict']))).toBe('transient');
    expect(classifyError(tx(['ConditionalCheckFailed', 'None']))).toBe('permanent');
    expect(classifyError(tx(['TransactionConflict', 'ConditionalCheckFailed']))).toBe('permanent');
  });

  it('ValidationException, ConditionalCheckFailed and plain errors are permanent', () => {
    expect(classifyError(named('ValidationException'))).toBe('permanent');
    expect(classifyError(named('ConditionalCheckFailedException'))).toBe('permanent');
    expect(classifyError(new Error('boom'))).toBe('permanent');
    expect(classifyError(undefined)).toBe('permanent');
  });
});

describe('withRetry', () => {
  it('retries transient errors with capped exponential backoff and then succeeds', async () => {
    const delays: number[] = [];
    let n = 0;
    const out = await withRetry(
      async () => {
        if (++n < 4) throw named('ThrottlingException');
        return 'ok';
      },
      { sleep: async (ms) => void delays.push(ms), rng: () => 1, baseMs: 100, capMs: 250 },
    );
    expect(out).toBe('ok');
    expect(delays).toEqual([100, 200, 250]);
  });

  it('gives up after 5 attempts and rethrows the last error', async () => {
    let n = 0;
    await expect(
      withRetry(async () => {
        n++;
        throw named('InternalServerError');
      }, noSleep),
    ).rejects.toThrow('InternalServerError');
    expect(n).toBe(5);
  });

  it('never retries a permanent error', async () => {
    let n = 0;
    await expect(
      withRetry(async () => {
        n++;
        throw named('ValidationException');
      }, noSleep),
    ).rejects.toThrow('ValidationException');
    expect(n).toBe(1);
  });

  it('backoff is full jitter under the cap', () => {
    for (let a = 1; a < 10; a++) expect(backoffMs(a, { rng: () => 0.999 })).toBeLessThanOrEqual(8000);
    expect(backoffMs(3, { rng: () => 0 })).toBe(0);
  });
});

describe('store clients retry transient errors', () => {
  it('DynamoStore retries a throttled transaction with the SAME request and ClientRequestToken', async () => {
    const tx: any[] = [];
    let fail = 2;
    const client = {
      send: async (cmd: any) => {
        if (cmd.constructor.name === 'GetCommand') return { Item: { lastSeq: 0 } };
        if (cmd.constructor.name === 'TransactWriteCommand') {
          tx.push(cmd.input);
          if (fail-- > 0) throw named('ProvisionedThroughputExceededException');
        }
        return {};
      },
    };
    const store = new DynamoStore({ tableName: 't', client: client as any, retry: noSleep });
    const [e] = await store.append('r1', [tickDraft(1)]);
    expect(e.seq).toBe(1);
    expect(tx).toHaveLength(3);
    expect(new Set(tx.map((i) => i.ClientRequestToken)).size).toBe(1);
    expect(tx[0].ClientRequestToken).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('DynamoStore does not retry a ValidationException (fails fast)', async () => {
    let calls = 0;
    const client = {
      send: async (cmd: any) => {
        if (cmd.constructor.name === 'GetCommand') return { Item: { lastSeq: 0 } };
        calls++;
        throw named('ValidationException');
      },
    };
    const store = new DynamoStore({ tableName: 't', client: client as any, retry: noSleep });
    const m = { system: 'mne' as const, entity: 'workOrders', id: 'w', op: 'create' as const, after: {} };
    const env = { actor: { kind: 'world' as const }, simMinute: 0, simTime: '2026-06-12T05:30:00.000Z' };
    await expect(store.append('r1', [mutationDraft(m, env)], [m])).rejects.toThrow('ValidationException');
    expect(calls).toBe(1);
  });

  it('DynamoStore.updateRun retries a 5xx', async () => {
    let n = 0;
    const client = {
      send: async () => {
        if (n++ === 0) throw named('InternalServerError', { $metadata: { httpStatusCode: 500 } });
        return {};
      },
    };
    const store = new DynamoStore({ tableName: 't', client: client as any, retry: noSleep });
    await store.updateRun('r1', { status: 'completed' });
    expect(n).toBe(2);
  });

  it('DynamoStore.decideApproval: a retried update whose first attempt landed still reports success', async () => {
    let n = 0;
    const client = {
      send: async (cmd: any) => {
        if (cmd.constructor.name === 'UpdateCommand') {
          n++;
          if (n === 1) throw named('TimeoutError'); // it actually committed
          throw named('ConditionalCheckFailedException');
        }
        return { Item: { record: { approvalId: 'apr-1', status: 'approved' } } };
      },
    };
    const store = new DynamoStore({ tableName: 't', client: client as any, retry: noSleep });
    expect(await store.decideApproval('r1', 'apr-1', 'pending', { status: 'approved' })).toBe(true);
  });

  it('S3TraceStore retries SlowDown', async () => {
    let n = 0;
    const client = {
      send: async () => {
        if (n++ < 2) throw named('SlowDown', { $metadata: { httpStatusCode: 503 } });
        return {};
      },
    };
    const traces = new S3TraceStore({ bucket: 'b', client: client as any, retry: noSleep });
    expect(await traces.put('r1', 1, { a: 1 })).toBe('traces/r1/1.json');
    expect(n).toBe(3);
  });

  it('SecretsManagerSecretStore retries, and does not cache a transient failure', async () => {
    let n = 0;
    let down = true;
    const client = {
      send: async () => {
        n++;
        if (down) throw named('ThrottlingException');
        return { SecretString: JSON.stringify({ K: 'v' }) };
      },
    };
    const secrets = new SecretsManagerSecretStore({
      secretIds: ['ica/llm'],
      client: client as any,
      retry: noSleep,
    });
    expect(await secrets.get('K')).toBeUndefined();
    expect(n).toBe(5);
    down = false;
    expect(await secrets.get('K')).toBe('v');
  });
});
