/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Cognito JWT verification for the WebSocket `$connect` route (the HTTP API uses API Gateway's JWT authorizer).
 * `aws-jwt-verify` checks the signature against the pool's JWKS, the issuer, `exp`, `token_use` and the app client
 * (`aud` for ID tokens, `client_id` for access tokens). Both token types are accepted.
 */
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { SimpleJwksCache } from 'aws-jwt-verify/jwk';
import type { JwtClaims } from '../http/types';

export type TokenVerifier = (token: string) => Promise<JwtClaims>;

export interface CognitoVerifierOptions {
  userPoolId: string;
  clientId: string;
  /** Tests: a JWKS to cache instead of fetching it from Cognito (network fetches are then disabled). */
  jwks?: { keys: Record<string, unknown>[] };
}

export function createCognitoVerifier(opts: CognitoVerifierOptions): TokenVerifier {
  const jwksCache = opts.jwks
    ? new SimpleJwksCache({
        fetcher: {
          fetch: async () => {
            throw new Error('JWKS fetching is disabled (static JWKS)');
          },
        },
      })
    : undefined;
  const verifiers = (['id', 'access'] as const).map((tokenUse) => {
    const props = { userPoolId: opts.userPoolId, clientId: opts.clientId, tokenUse };
    const v = jwksCache ? CognitoJwtVerifier.create(props, { jwksCache }) : CognitoJwtVerifier.create(props);
    if (opts.jwks) v.cacheJwks(opts.jwks as never);
    return v;
  });
  return async (token: string) => {
    let lastErr: unknown;
    for (const v of verifiers) {
      try {
        return (await v.verify(token)) as unknown as JwtClaims;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('invalid token');
  };
}
