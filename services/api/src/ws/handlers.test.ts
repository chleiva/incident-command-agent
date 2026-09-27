/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import { createSign, generateKeyPairSync } from 'node:crypto';
import { MemoryStore } from '@ica/store';
import { beforeAll, describe, expect, it } from 'vitest';
import { SCENARIO } from '../test-helpers';
import { createConnectHandler, createDefaultHandler, createDisconnectHandler } from './handlers';
import { createCognitoVerifier } from './jwt';

const REGION = 'eu-west-2';
const POOL = `${REGION}_TestPool1`;
const CLIENT = 'testclientid123';
const ISS = `https://cognito-idp.${REGION}.amazonaws.com/${POOL}`;
const KID = 'test-key-1';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const { privateKey: otherKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' };

const b64 = (x: unknown) => Buffer.from(JSON.stringify(x)).toString('base64url');
function sign(claims: Record<string, unknown>, key = privateKey, kid = KID): string {
  const head = b64({ alg: 'RS256', kid, typ: 'JWT' });
  const body = b64(claims);
  const s = createSign('RSA-SHA256').update(`${head}.${body}`).sign(key).toString('base64url');
  return `${head}.${body}.${s}`;
}

const now = () => Math.floor(Date.now() / 1000);
const idToken = (over: Record<string, unknown> = {}) =>
  sign({
    sub: 'u-1',
    email: 'duty.manager@example.com',
    iss: ISS,
    aud: CLIENT,
    token_use: 'id',
    iat: now() - 10,
    exp: now() + 3600,
    ...over,
  });

describe('WebSocket $connect', () => {
  let store: MemoryStore;
  const verify = createCognitoVerifier({ userPoolId: POOL, clientId: CLIENT, jwks: { keys: [jwk] } });
  const handler = () => createConnectHandler({ store, authMode: 'cognito', verify });
  const ev = (q: Record<string, string>, connectionId = 'conn-1') => ({
    requestContext: { connectionId, routeKey: '$connect' },
    queryStringParameters: q,
  });

  beforeAll(async () => {
    store = new MemoryStore();
    await store.createRun({
      runId: 'run-1',
      scenarioId: SCENARIO.id,
      scenarioTitle: SCENARIO.title,
      mode: 'agent',
      status: 'running',
      createdAt: new Date().toISOString(),
      simMinute: 0,
      lastSeq: 0,
      totals: { inputTokens: 0, outputTokens: 0, costUsd: 0, toolCalls: 0, iterations: 0, wallMs: 0 },
      speed: 6,
    });
  });

  it('accepts a valid Cognito ID token and stores the connection', async () => {
    expect(await handler()(ev({ runId: 'run-1', token: idToken() }))).toEqual({ statusCode: 200 });
    expect(await store.listConnections('run-1')).toEqual(['conn-1']);
  });

  it('accepts a valid access token (client_id instead of aud)', async () => {
    const access = sign({
      sub: 'u-1',
      iss: ISS,
      client_id: CLIENT,
      token_use: 'access',
      scope: 'openid email profile',
      iat: now() - 10,
      exp: now() + 3600,
    });
    expect((await handler()(ev({ runId: 'run-1', token: access }, 'conn-2'))).statusCode).toBe(200);
  });

  it.each([
    ['expired', () => idToken({ exp: now() - 60 })],
    ['wrong audience', () => idToken({ aud: 'someone-else' })],
    ['wrong issuer', () => idToken({ iss: `https://cognito-idp.${REGION}.amazonaws.com/${REGION}_Other` })],
    ['wrong token_use', () => idToken({ token_use: 'refresh' })],
    ['bad signature', () => sign({ iss: ISS, aud: CLIENT, token_use: 'id', exp: now() + 60 }, otherKey)],
    [
      'unknown kid',
      () => sign({ iss: ISS, aud: CLIENT, token_use: 'id', exp: now() + 60 }, privateKey, 'nope'),
    ],
    ['garbage', () => 'not.a.jwt'],
  ])('rejects a token with %s (401)', async (_name, token) => {
    const r = await handler()(ev({ runId: 'run-1', token: token() }, 'conn-x'));
    expect(r.statusCode).toBe(401);
    expect(await store.listConnections('run-1')).not.toContain('conn-x');
  });

  it('requires token and runId, and a known run', async () => {
    expect((await handler()(ev({ runId: 'run-1' }))).statusCode).toBe(401);
    expect((await handler()(ev({ token: idToken() }))).statusCode).toBe(400);
    expect((await handler()(ev({ runId: 'run-unknown', token: idToken() }))).statusCode).toBe(404);
  });

  it('skips verification only with AUTH_MODE=none', async () => {
    const local = createConnectHandler({ store, authMode: 'none' });
    expect((await local(ev({ runId: 'run-1' }, 'conn-local'))).statusCode).toBe(200);
    expect(() => createConnectHandler({ store, authMode: 'cognito' })).toThrow(/verifier/);
  });

  it('$disconnect deletes the connection; $default answers pings', async () => {
    await createDisconnectHandler({ store })({ requestContext: { connectionId: 'conn-1' } });
    expect(await store.listConnections('run-1')).not.toContain('conn-1');
    const d = createDefaultHandler();
    expect(await d({ requestContext: {}, body: '{"action":"ping"}' })).toEqual({
      statusCode: 200,
      body: '{"kind":"ping"}',
    });
    expect(await d({ requestContext: {}, body: 'nonsense' })).toEqual({ statusCode: 200 });
  });
});
