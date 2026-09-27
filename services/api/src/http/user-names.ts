/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Human-readable approver names. The SPA sends the Cognito ACCESS token, whose claims carry no email or name (only
 * `sub` and `username`, both the user's UUID when the pool signs in by email). The router therefore resolves the
 * display name with Cognito `AdminGetUser` (username from the claims), cached per container. Failures fall back to
 * the username, so a Cognito outage never blocks an approval.
 */
import {
  AdminGetUserCommand,
  type CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import type { Logger } from '../util/log';

/** Resolves a Cognito username to a display name (null when unknown). */
export type UserNameResolver = (username: string) => Promise<string | null>;

type Attributes = Record<string, string | undefined>;

/** `name`, else `given_name family_name`, else `email`, else `preferred_username`. */
export function displayNameFrom(attrs: Attributes): string | null {
  const clean = (v: string | undefined) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const full = [clean(attrs.given_name), clean(attrs.family_name)].filter(Boolean).join(' ');
  return (
    clean(attrs.name) ?? (full || undefined) ?? clean(attrs.email) ?? clean(attrs.preferred_username) ?? null
  );
}

export interface CognitoResolverOptions {
  client: Pick<CognitoIdentityProviderClient, 'send'>;
  userPoolId: string;
  log?: Logger;
  /** How long a failed lookup is remembered before retrying (default 60 s). */
  failureTtlMs?: number;
  now?: () => number;
}

/** `AdminGetUser`-backed resolver with a per-container cache (successes forever, failures for `failureTtlMs`). */
export function createCognitoUserNameResolver(opts: CognitoResolverOptions): UserNameResolver {
  const hits = new Map<string, string | null>();
  const misses = new Map<string, number>();
  const inflight = new Map<string, Promise<string | null>>();
  const now = opts.now ?? Date.now;
  const failureTtl = opts.failureTtlMs ?? 60_000;
  return async (username) => {
    if (hits.has(username)) return hits.get(username)!;
    const missAt = misses.get(username);
    if (missAt !== undefined && now() - missAt < failureTtl) return null;
    const pending = inflight.get(username);
    if (pending) return pending;
    const p = (async () => {
      try {
        const out = await opts.client.send(
          new AdminGetUserCommand({ UserPoolId: opts.userPoolId, Username: username }),
        );
        const attrs: Attributes = Object.fromEntries(
          (out.UserAttributes ?? []).map((a) => [a.Name ?? '', a.Value]),
        );
        const name = displayNameFrom(attrs);
        hits.set(username, name);
        misses.delete(username);
        return name;
      } catch (err) {
        misses.set(username, now());
        opts.log?.warn('user name lookup failed', { error: (err as Error).name || 'Error' });
        return null;
      } finally {
        inflight.delete(username);
      }
    })();
    inflight.set(username, p);
    return p;
  };
}
