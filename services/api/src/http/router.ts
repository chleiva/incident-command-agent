/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * A tiny, dependency-free router for API Gateway HTTP API payload v2.0 events. The route table is `API_ROUTES`
 * from @ica/schema, so the Lambda, the local dev server and the CDK routes can never drift apart.
 */
import { API_ROUTES, type Actor, type ApiError, type ApiRouteName } from '@ica/schema';
import type { AuthMode } from '../config/settings';
import { errorFields, silentLogger, type Logger } from '../util/log';
import { HttpError, badRequest, unauthorized } from './errors';
import type { HttpEvent, HttpResult, JwtClaims } from './types';

export const MAX_BODY_BYTES = 64 * 1024;

export interface Principal {
  /** Display name recorded on human decisions (name/email claim, else the Cognito profile, else username). */
  name: string;
  sub?: string;
  /** Cognito username (`cognito:username` on ID tokens, `username` on access tokens). */
  username?: string;
  /** True when `name` came from a human-readable claim (`name`, `given_name`/`family_name`, `email`). */
  readable?: boolean;
}

export interface RouteContext {
  params: Record<string, string>;
  query: Record<string, string | undefined>;
  /** Parsed JSON body (undefined when there is none). */
  body: unknown;
  principal: Principal;
  requestId: string;
  log: Logger;
  /** Adds a field (e.g. runId) to the request's summary log line. */
  annotate(fields: Record<string, unknown>): void;
}

export interface RouteResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export type RouteHandler = (ctx: RouteContext) => Promise<RouteResponse>;
export type RouteTable = Record<ApiRouteName, RouteHandler>;

interface CompiledRoute {
  name: ApiRouteName;
  method: string;
  segments: string[];
}

const COMPILED: CompiledRoute[] = (Object.keys(API_ROUTES) as ApiRouteName[]).map((name) => ({
  name,
  method: API_ROUTES[name].method,
  segments: API_ROUTES[name].path.split('/').filter(Boolean),
}));

/** Match a method + path against `API_ROUTES`. Returns `methodMismatch` when only the method is wrong. */
export function matchRoute(
  method: string,
  path: string,
): { name: ApiRouteName; params: Record<string, string> } | { methodMismatch: true } | null {
  const parts = path.split('/').filter(Boolean);
  let mismatch = false;
  for (const r of COMPILED) {
    if (r.segments.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < parts.length; i++) {
      const seg = r.segments[i];
      if (seg.startsWith('{') && seg.endsWith('}')) {
        let v: string;
        try {
          v = decodeURIComponent(parts[i]);
        } catch {
          ok = false;
          break;
        }
        params[seg.slice(1, -1)] = v;
      } else if (seg !== parts[i]) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    if (r.method !== method) {
      mismatch = true;
      continue;
    }
    return { name: r.name, params };
  }
  return mismatch ? { methodMismatch: true } : null;
}

export function principalFromClaims(claims: JwtClaims | undefined): Principal | null {
  if (!claims) return null;
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const full = [str(claims.given_name), str(claims.family_name)].filter(Boolean).join(' ');
  const readable = str(claims.name) ?? (full || undefined) ?? str(claims.email);
  const username = str(claims['cognito:username']) ?? str(claims.username);
  const sub = str(claims.sub);
  const name = readable ?? username ?? sub;
  if (!name) return null;
  return {
    name,
    ...(sub ? { sub } : {}),
    ...(username ? { username } : {}),
    ...(readable ? { readable: true } : {}),
  };
}

/** The human actor for API-written events. */
export function humanActor(p: Principal, roleTitle = 'Duty Manager'): Actor {
  return { kind: 'human', name: p.name, roleTitle };
}

export interface RouterOptions {
  authMode: AuthMode;
  corsOrigins: string[];
  localOperatorName: string;
  log?: Logger;
  /**
   * Resolves a Cognito username to a display name when the token carries no readable claim (the SPA sends the
   * access token: only `sub`/`username`). Lambda: `AdminGetUser`, cached per container (see user-names.ts).
   */
  resolveUserName?: (username: string) => Promise<string | null>;
}

/** A readable name for the principal: claims first, then the resolver, else the username/sub. */
async function withDisplayName(p: Principal, opts: RouterOptions, log: Logger): Promise<Principal> {
  if (p.readable || !opts.resolveUserName) return p;
  const key = p.username ?? p.sub;
  if (!key) return p;
  try {
    const name = await opts.resolveUserName(key);
    return name ? { ...p, name, readable: true } : p;
  } catch (err) {
    log.warn('user name resolution failed', errorFields(err));
    return p;
  }
}

function corsHeaders(opts: RouterOptions, origin: string | undefined): Record<string, string> {
  const h: Record<string, string> = {};
  if (opts.authMode === 'none' && opts.corsOrigins.includes('*')) {
    h['access-control-allow-origin'] = '*';
  } else if (origin && opts.corsOrigins.includes(origin)) {
    h['access-control-allow-origin'] = origin;
    h.vary = 'Origin';
  }
  if (h['access-control-allow-origin']) {
    h['access-control-allow-headers'] = 'authorization,content-type';
    h['access-control-allow-methods'] = 'GET,POST,OPTIONS';
    h['access-control-max-age'] = '3600';
  }
  return h;
}

function header(event: HttpEvent, name: string): string | undefined {
  const hs = event.headers ?? {};
  return hs[name] ?? Object.entries(hs).find(([k]) => k.toLowerCase() === name)?.[1];
}

function parseBody(event: HttpEvent): unknown {
  if (event.body === undefined || event.body === null || event.body === '') return undefined;
  const text = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) {
    throw new HttpError(413, 'payload_too_large', `request body exceeds ${MAX_BODY_BYTES} bytes`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw badRequest('request body is not valid JSON');
  }
}

function parseQuery(event: HttpEvent): Record<string, string | undefined> {
  if (event.queryStringParameters) return { ...event.queryStringParameters };
  const out: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(event.rawQueryString ?? '')) out[k] = v;
  return out;
}

/** Build the HTTP API v2 handler over a route table. */
export function createRouter(routes: RouteTable, opts: RouterOptions) {
  const baseLog = opts.log ?? silentLogger;
  return async function handle(event: HttpEvent): Promise<HttpResult> {
    const started = Date.now();
    const method = (event.requestContext?.http?.method ?? 'GET').toUpperCase();
    const path = event.rawPath || event.requestContext?.http?.path || '/';
    const requestId = event.requestContext?.requestId ?? `local-${started.toString(36)}`;
    const summary: Record<string, unknown> = { requestId, method, path };
    const log = baseLog.child({ requestId });
    const cors = corsHeaders(opts, header(event, 'origin'));
    const respond = (status: number, body: unknown, extra: Record<string, string> = {}): HttpResult => ({
      statusCode: status,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        ...cors,
        ...extra,
      },
      body: body === undefined ? '' : JSON.stringify(body),
    });
    const fail = (err: HttpError): HttpResult => {
      const body: ApiError & Record<string, unknown> = { error: err.message, code: err.code, ...err.extra };
      return respond(err.status, body);
    };

    let result: HttpResult;
    try {
      if (method === 'OPTIONS') {
        result = { statusCode: 204, headers: { ...cors } };
      } else {
        const match = matchRoute(method, path);
        if (!match) throw new HttpError(404, 'route_not_found', `no route for ${method} ${path}`);
        if ('methodMismatch' in match) {
          throw new HttpError(405, 'method_not_allowed', `${method} not allowed on ${path}`);
        }
        summary.route = match.name;
        if (match.params.id) summary.runId = match.params.id;

        let principal = principalFromClaims(event.requestContext?.authorizer?.jwt?.claims);
        if (!principal) {
          if (opts.authMode !== 'none') throw unauthorized();
          principal = { name: opts.localOperatorName, readable: true };
        } else {
          principal = await withDisplayName(principal, opts, log);
        }
        const ctx: RouteContext = {
          params: match.params,
          query: parseQuery(event),
          body: method === 'POST' ? parseBody(event) : undefined,
          principal,
          requestId,
          log: log.child({ route: match.name, ...(match.params.id ? { runId: match.params.id } : {}) }),
          annotate: (f) => Object.assign(summary, f),
        };
        const res = await routes[match.name](ctx);
        result = respond(res.status ?? 200, res.body, res.headers);
      }
    } catch (err) {
      if (err instanceof HttpError) {
        result = fail(err);
        summary.code = err.code;
      } else {
        log.error('unhandled error', { ...summary, ...errorFields(err) });
        result = fail(new HttpError(500, 'internal_error', 'internal error'));
      }
    }
    log.info('request', { ...summary, status: result.statusCode, latencyMs: Date.now() - started });
    return result;
  };
}
