/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** WebSocket API route handlers: `$connect` (JWT + runId), `$disconnect`, `$default` (ping). */
import type { Store, WsServerMessage } from '@ica/schema';
import type { AuthMode } from '../config/settings';
import { errorFields, silentLogger, type Logger } from '../util/log';
import type { TokenVerifier } from './jwt';

export interface WsEvent {
  requestContext: { connectionId?: string; routeKey?: string; requestId?: string };
  queryStringParameters?: Record<string, string | undefined> | null;
  body?: string | null;
  isBase64Encoded?: boolean;
}

export interface WsResult {
  statusCode: number;
  body?: string;
}

const RUN_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

export interface ConnectDeps {
  store: Pick<Store, 'getRun' | 'putConnection'>;
  authMode: AuthMode;
  verify?: TokenVerifier;
  log?: Logger;
}

export function createConnectHandler(deps: ConnectDeps) {
  const log = deps.log ?? silentLogger;
  if (deps.authMode !== 'none' && !deps.verify) throw new Error('a token verifier is required');
  return async (event: WsEvent): Promise<WsResult> => {
    const connectionId = event.requestContext.connectionId;
    const q = event.queryStringParameters ?? {};
    const runId = q.runId;
    if (!connectionId) return { statusCode: 400, body: 'missing connection id' };
    if (!runId || !RUN_ID_RE.test(runId)) return { statusCode: 400, body: 'runId is required' };
    if (deps.authMode !== 'none') {
      if (!q.token) return { statusCode: 401, body: 'token is required' };
      try {
        await deps.verify!(q.token);
      } catch (err) {
        log.warn('ws connect rejected: invalid token', { connectionId, runId, errName: (err as Error).name });
        return { statusCode: 401, body: 'unauthorized' };
      }
    }
    try {
      if (!(await deps.store.getRun(runId))) return { statusCode: 404, body: 'run not found' };
      await deps.store.putConnection(connectionId, runId);
    } catch (err) {
      log.error('ws connect failed', { connectionId, runId, ...errorFields(err) });
      return { statusCode: 500, body: 'internal error' };
    }
    log.info('ws connected', { connectionId, runId });
    return { statusCode: 200 };
  };
}

export function createDisconnectHandler(deps: { store: Pick<Store, 'deleteConnection'>; log?: Logger }) {
  const log = deps.log ?? silentLogger;
  return async (event: WsEvent): Promise<WsResult> => {
    const connectionId = event.requestContext.connectionId;
    if (connectionId) {
      await deps.store.deleteConnection(connectionId);
      log.info('ws disconnected', { connectionId });
    }
    return { statusCode: 200 };
  };
}

/** `$default`: replies to `{action:'ping'}` with `{kind:'ping'}` (route response); ignores anything else. */
export function createDefaultHandler() {
  return async (event: WsEvent): Promise<WsResult> => {
    try {
      const raw = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString() : event.body;
      const msg = JSON.parse(raw ?? '{}') as { action?: string };
      if (msg.action === 'ping') {
        return { statusCode: 200, body: JSON.stringify({ kind: 'ping' } satisfies WsServerMessage) };
      }
    } catch {
      /* ignore malformed frames */
    }
    return { statusCode: 200 };
  };
}
