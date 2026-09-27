/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Local dev server (spec §12): a Node HTTP server that mounts THE SAME router as the `api` Lambda (Node requests
 * are adapted to the HTTP API v2 event shape) plus a `ws` endpoint at `/ws?runId=` fed by the in-memory EventBus
 * with the same `{kind:'events'}` messages as the fan-out Lambda. AUTH_MODE=none only.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { EventBus, RunEvent, Store, WsServerMessage } from '@ica/schema';
import { WebSocketServer, type WebSocket } from 'ws';
import { createApiHandler } from '../http/routes';
import type { ApiDeps } from '../http/deps';
import { MAX_BODY_BYTES } from '../http/router';
import type { HttpEvent } from '../http/types';
import { chunkMessages } from '../ws/fanout';
import { silentLogger } from '../util/log';

export interface LocalAppOptions extends ApiDeps {
  bus: EventBus;
  store: Store;
}

export function toHttpEvent(req: IncomingMessage, body: string, requestId: string): HttpEvent {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v !== undefined) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(',') : v;
  }
  const query: Record<string, string> = {};
  for (const [k, v] of url.searchParams) query[k] = v;
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath: url.pathname,
    rawQueryString: url.search.replace(/^\?/, ''),
    headers,
    queryStringParameters: Object.keys(query).length ? query : undefined,
    body: body || undefined,
    isBase64Encoded: false,
    requestContext: {
      requestId,
      http: {
        method: (req.method ?? 'GET').toUpperCase(),
        path: url.pathname,
        sourceIp: req.socket.remoteAddress,
      },
    },
  };
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY_BYTES * 2) throw new Error('body too large');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export interface LocalApp {
  server: Server;
  wss: WebSocketServer;
  listen(port: number, host?: string): Promise<number>;
  close(): Promise<void>;
}

export function createLocalApp(opts: LocalAppOptions): LocalApp {
  if (opts.settings.authMode !== 'none') throw new Error('the local dev server only supports AUTH_MODE=none');
  const log = opts.log ?? silentLogger;
  const api = createApiHandler(opts);
  let counter = 0;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const requestId = `local-${Date.now().toString(36)}-${(counter++).toString(36)}`;
    readBody(req)
      .then((body) => api(toHttpEvent(req, body, requestId)))
      .then((r) => {
        res.writeHead(r.statusCode, r.headers ?? {});
        res.end(r.body ?? '');
      })
      .catch((err) => {
        log.error('local server error', { requestId, errMessage: String(err) });
        if (!res.headersSent) res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'bad request', code: 'bad_request' }));
      });
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const runId = url.searchParams.get('runId');
    if (url.pathname !== '/ws' || !runId) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, runId));
  });

  wss.on('connection', (ws: WebSocket, _req: IncomingMessage, runId: string) => {
    const send = (events: RunEvent[]) => {
      if (ws.readyState !== ws.OPEN) return;
      for (const m of chunkMessages(runId, events).messages) ws.send(m);
    };
    const unsubscribe = opts.bus.subscribe(runId, send);
    log.info('ws connected', { runId });
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString()) as { action?: string };
        if (msg.action === 'ping') ws.send(JSON.stringify({ kind: 'ping' } satisfies WsServerMessage));
      } catch {
        /* ignore */
      }
    });
    ws.on('close', () => {
      unsubscribe();
      log.info('ws disconnected', { runId });
    });
  });

  return {
    server,
    wss,
    listen: (port, host = '127.0.0.1') =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => resolve((server.address() as AddressInfo).port));
      }),
    close: () =>
      new Promise<void>((resolve) => {
        for (const c of wss.clients) c.terminate();
        wss.close();
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}
