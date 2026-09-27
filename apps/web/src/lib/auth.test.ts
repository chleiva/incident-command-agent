/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** Cognito boot must never try iframe silent sign-in (Cognito ignores prompt=none and denies framing). */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls: string[] = [];
type FakeUser = { expired: boolean; refresh_token?: string; access_token: string; profile: object };
let storedUser: FakeUser | null = null;
let silentResult: FakeUser | null = null;
let storeKind: unknown;

vi.mock('oidc-client-ts', () => ({
  WebStorageStateStore: class {
    constructor(opts: { store: unknown }) {
      storeKind = opts.store;
    }
  },
  UserManager: class {
    events = { addUserLoaded: () => {} };
    async getUser() {
      calls.push('getUser');
      return storedUser;
    }
    async signinSilent() {
      calls.push('signinSilent');
      return silentResult;
    }
    async signinRedirect() {
      calls.push('signinRedirect');
    }
    async signinRedirectCallback() {
      calls.push('signinRedirectCallback');
    }
    async removeUser() {
      calls.push('removeUser');
    }
  },
}));

import { createAuth } from './auth';

const config = {
  apiUrl: 'https://api.example',
  wsUrl: 'wss://ws.example',
  auth: {
    mode: 'cognito' as const,
    region: 'eu-west-2',
    userPoolId: 'eu-west-2_pool',
    clientId: 'client',
    domain: 'example.auth.eu-west-2.amazoncognito.com',
    redirectUri: 'https://site.example/',
  },
};

const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  calls.length = 0;
  storedUser = null;
  silentResult = null;
});

describe('Cognito boot', () => {
  it('redirects straight to the hosted UI when there is no session (no iframe attempt)', async () => {
    void createAuth(config as never);
    await settle();
    expect(calls).toEqual(['getUser', 'signinRedirect']);
  });

  it('keeps the session in localStorage so reloads and new tabs stay signed in', async () => {
    storedUser = { expired: false, access_token: 't', profile: {} };
    await createAuth(config as never);
    expect(storeKind).toBe(window.localStorage);
  });

  it('uses a valid stored session without any network step', async () => {
    storedUser = { expired: false, access_token: 't', profile: {} };
    const session = await createAuth(config as never);
    expect(calls).toEqual(['getUser']);
    expect(await session.getToken()).toBe('t');
  });

  it('renews an expired session only with its refresh token', async () => {
    storedUser = { expired: true, refresh_token: 'r', access_token: 'old', profile: {} };
    silentResult = { expired: false, access_token: 'new', profile: {} };
    const session = await createAuth(config as never);
    expect(calls).toEqual(['getUser', 'signinSilent']);
    expect(await session.getToken()).toBe('new');
  });

  it('goes to the hosted UI when an expired session has no refresh token', async () => {
    storedUser = { expired: true, access_token: 'old', profile: {} };
    void createAuth(config as never);
    await settle();
    expect(calls).toEqual(['getUser', 'signinRedirect']);
  });

  it('clears the session and redirects when the refresh fails', async () => {
    storedUser = { expired: true, refresh_token: 'r', access_token: 'old', profile: {} };
    silentResult = null;
    void createAuth(config as never);
    await settle();
    expect(calls).toEqual(['getUser', 'signinSilent', 'removeUser', 'signinRedirect']);
  });
});
