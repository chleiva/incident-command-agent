/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Live run 1, bug 3: `approval.decision.decidedBy.name` was the Cognito sub (the SPA sends the access token, which
 * has no email/name claim). The API now resolves a readable name; Cognito is mocked (no network).
 */
import { AdminGetUserCommand } from '@aws-sdk/client-cognito-identity-provider';
import { describe, expect, it, vi } from 'vitest';
import { json, makeDeps, pendingApproval, req, SCENARIO } from '../test-helpers';
import { principalFromClaims } from './router';
import { createCognitoUserNameResolver, displayNameFrom } from './user-names';

const SUB = '56322224-60e1-703a-bd84-1837fca87745';
/** What API Gateway's JWT authorizer passes for a Cognito ACCESS token (no email/name). */
const ACCESS_CLAIMS = { sub: SUB, username: SUB, token_use: 'access', client_id: 'client-1' };

function mockCognito(attrs: Record<string, string> | Error) {
  const send = vi.fn(async (cmd: unknown) => {
    expect(cmd).toBeInstanceOf(AdminGetUserCommand);
    if (attrs instanceof Error) throw attrs;
    return { UserAttributes: Object.entries(attrs).map(([Name, Value]) => ({ Name, Value })) };
  });
  return { client: { send } as never, send };
}

async function decide(h: ReturnType<typeof makeDeps>, claims: Record<string, unknown> | null) {
  const created = await h.handler(req('POST', '/runs', { body: { scenarioId: SCENARIO.id, mode: 'agent' } }));
  const { runId } = json<{ runId: string }>(created);
  await h.store.putApproval(pendingApproval(runId));
  const r = await h.handler(
    req('POST', `/runs/${runId}/approvals/apr-1`, { body: { decision: 'approve' }, claims }),
  );
  expect(r.statusCode).toBe(200);
  const [e] = (await h.store.listEvents(runId, 1)).events;
  return (e!.payload as { decidedBy: { name: string } }).decidedBy.name;
}

describe('approver display names', () => {
  it('prefers readable claims (ID token): name, then given/family name, then email', () => {
    expect(principalFromClaims({ sub: SUB, name: 'Sam Okafor', email: 'sam@example.com' })).toMatchObject({
      name: 'Sam Okafor',
      readable: true,
    });
    expect(principalFromClaims({ sub: SUB, given_name: 'Sam', family_name: 'Okafor' })?.name).toBe(
      'Sam Okafor',
    );
    expect(principalFromClaims({ sub: SUB, email: 'sam@example.com' })?.name).toBe('sam@example.com');
    expect(principalFromClaims(ACCESS_CLAIMS)).toEqual({ name: SUB, sub: SUB, username: SUB });
  });

  it('displayNameFrom: name > given+family > email > preferred_username', () => {
    expect(displayNameFrom({ email: 'a@example.com', name: 'A B' })).toBe('A B');
    expect(displayNameFrom({ email: 'a@example.com', given_name: 'A' })).toBe('A');
    expect(displayNameFrom({ email: 'a@example.com' })).toBe('a@example.com');
    expect(displayNameFrom({ preferred_username: 'duty' })).toBe('duty');
    expect(displayNameFrom({})).toBeNull();
  });

  it('access token: records the Cognito profile name (AdminGetUser, cached per container)', async () => {
    const { client, send } = mockCognito({ sub: SUB, email: 'duty.manager@example.com' });
    const resolveUserName = createCognitoUserNameResolver({ client, userPoolId: 'eu-west-2_pool' });
    const h = makeDeps({ resolveUserName });
    expect(await decide(h, ACCESS_CLAIMS)).toBe('duty.manager@example.com');
    expect(send).toHaveBeenCalledTimes(1);
    const cmd = send.mock.calls[0]![0] as AdminGetUserCommand;
    expect(cmd.input).toEqual({ UserPoolId: 'eu-west-2_pool', Username: SUB });
    // Cached: later requests (run creation + a second decision) do not call Cognito again.
    expect(await decide(h, ACCESS_CLAIMS)).toBe('duty.manager@example.com');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('does not call Cognito when the token already has a readable claim', async () => {
    const { client, send } = mockCognito({ email: 'other@example.com' });
    const h = makeDeps({ resolveUserName: createCognitoUserNameResolver({ client, userPoolId: 'p' }) });
    expect(await decide(h, { ...ACCESS_CLAIMS, email: 'duty.manager@example.com' })).toBe(
      'duty.manager@example.com',
    );
    expect(send).not.toHaveBeenCalled();
  });

  it('falls back to the username when the lookup fails, and retries only after the failure TTL', async () => {
    const { client, send } = mockCognito(new Error('AccessDenied'));
    let t = 0;
    const resolve = createCognitoUserNameResolver({
      client,
      userPoolId: 'p',
      failureTtlMs: 1000,
      now: () => t,
    });
    const h = makeDeps({ resolveUserName: resolve });
    expect(await decide(h, ACCESS_CLAIMS)).toBe(SUB);
    expect(send).toHaveBeenCalledTimes(1);
    expect(await resolve(SUB)).toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
    t = 5000;
    expect(await resolve(SUB)).toBeNull();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('local mode (AUTH_MODE=none) keeps the local operator name without any lookup', async () => {
    const { client, send } = mockCognito({ email: 'x@example.com' });
    const h = makeDeps({
      env: { AUTH_MODE: 'none', CORS_ORIGINS: '*' },
      resolveUserName: createCognitoUserNameResolver({ client, userPoolId: 'p' }),
    });
    expect(await decide(h, null)).toBe('Local Operator');
    expect(send).not.toHaveBeenCalled();
  });
});
