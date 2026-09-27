/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Authentication. `mode:'none'` (local dev server, mock mode): no login. `mode:'cognito'`: the hosted UI with the
 * authorization-code flow + PKCE (oidc-client-ts), refresh-token renewal, bearer token on fetch, `token=` on the WebSocket.
 *
 * No iframe "silent sign-in": Cognito ignores `prompt=none` and serves `X-Frame-Options: DENY`, so an iframe attempt
 * only waits for its timeout (a multi-second blank page). Sessions renew with the refresh token (a plain HTTPS call);
 * without a usable session we go straight to the hosted UI. The session lives in localStorage so reloads and new tabs
 * stay signed in (single-user app; strict CSP forbids inline script).
 * oidc-client-ts is loaded lazily so local and mock builds never download it.
 */
import type { WebRuntimeConfig } from '@ica/schema/browser';

export interface AuthSession {
  mode: 'none' | 'cognito';
  /** Current access token, or null when unauthenticated / not needed. */
  getToken(): Promise<string | null>;
  /** Display name of the signed-in user (approver identity), when known. */
  userName(): string | null;
  logout(): Promise<void>;
}

const NO_AUTH: AuthSession = {
  mode: 'none',
  getToken: async () => null,
  userName: () => null,
  logout: async () => {},
};

type CognitoAuth = Extract<WebRuntimeConfig['auth'], { mode: 'cognito' }>;

export async function createAuth(config: WebRuntimeConfig): Promise<AuthSession> {
  if (config.auth.mode === 'none') return NO_AUTH;
  return createCognitoAuth(config.auth);
}

async function createCognitoAuth(auth: CognitoAuth): Promise<AuthSession> {
  const { UserManager, WebStorageStateStore } = await import('oidc-client-ts');
  const domain = auth.domain.startsWith('http') ? auth.domain : `https://${auth.domain}`;
  const manager = new UserManager({
    authority: `https://cognito-idp.${auth.region}.amazonaws.com/${auth.userPoolId}`,
    client_id: auth.clientId,
    redirect_uri: auth.redirectUri,
    post_logout_redirect_uri: auth.redirectUri,
    response_type: 'code', // authorization code + PKCE (S256) is the oidc-client-ts default
    scope: 'openid email profile',
    // Renewal uses the refresh token (oidc-client-ts does not open an iframe when one is present).
    automaticSilentRenew: true,
    userStore: new WebStorageStateStore({ store: window.localStorage }),
  });

  // Returning from the hosted UI.
  const params = new URLSearchParams(window.location.search);
  if (params.has('code') && params.has('state')) {
    await manager.signinRedirectCallback();
    window.history.replaceState({}, '', window.location.pathname);
  }

  const redirectToLogin = async (): Promise<AuthSession> => {
    await manager.signinRedirect();
    // The browser navigates away; keep the promise pending.
    return new Promise<AuthSession>(() => {});
  };

  let user = await manager.getUser();
  if (!user) return redirectToLogin();
  if (user.expired) {
    // Refresh-token grant only: never fall back to the iframe flow (see header comment).
    if (!user.refresh_token) return redirectToLogin();
    try {
      user = await manager.signinSilent();
    } catch {
      user = null;
    }
    if (!user || user.expired) {
      await manager.removeUser();
      return redirectToLogin();
    }
  }
  manager.events.addUserLoaded((u) => {
    user = u;
  });

  return {
    mode: 'cognito',
    getToken: async () => (user && !user.expired ? user.access_token : null),
    userName: () =>
      (user?.profile.name as string | undefined) ?? (user?.profile.email as string | undefined) ?? null,
    logout: async () => {
      await manager.removeUser();
      // Cognito's logout endpoint takes client_id + logout_uri rather than the OIDC end-session parameters.
      window.location.href = `${domain}/logout?client_id=${encodeURIComponent(auth.clientId)}&logout_uri=${encodeURIComponent(auth.redirectUri)}`;
    },
  };
}

/** WebSocket URL with the run subscription and (Cognito) the JWT in the query string (spec §5). */
export function socketUrl(wsUrl: string, runId: string, token: string | null): string {
  const u = new URL(wsUrl);
  u.searchParams.set('runId', runId);
  if (token) u.searchParams.set('token', token);
  return u.toString();
}
