/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * DynamoDB Streams → WebSocket fan-out (spec §5). The event-source filter only delivers `EVT#` rows (INSERT,
 * NEW_IMAGE); `SYS#`/`APR#` rows never reach browsers (the UI rebuilds state from events). Records are grouped by
 * run, sorted by seq, rehydrated with `itemToEvent` (oversized payloads live in the TraceStore) and posted as
 * `{kind:'events', runId, events}` messages of at most 128 KB. Stale connections are purged on GoneException.
 * Failures are reported as partial batch failures so Lambda retries from the earliest failed record; duplicates
 * are harmless because the reducer ignores `seq <= lastSeq`.
 */
import { unmarshall } from '@aws-sdk/util-dynamodb';
import type { RunEvent, Store, TraceStore, WsServerMessage } from '@ica/schema';
import { itemToEvent } from '@ica/store';
import { errorFields, silentLogger, type Logger } from '../util/log';

/** API Gateway WebSocket frame limit for PostToConnection payloads. */
export const MAX_WS_MESSAGE_BYTES = 128 * 1024;

export interface StreamRecord {
  eventID?: string;
  eventName?: 'INSERT' | 'MODIFY' | 'REMOVE' | string;
  dynamodb?: {
    Keys?: Record<string, unknown>;
    NewImage?: Record<string, unknown>;
    SequenceNumber?: string;
  };
}

export interface StreamEvent {
  Records: StreamRecord[];
}

export interface BatchResponse {
  batchItemFailures: { itemIdentifier: string }[];
}

/** Posts one message to one connection. Must throw an error named `GoneException` (or with HTTP 410) if stale. */
export type PostToConnection = (connectionId: string, data: string) => Promise<void>;

export interface FanoutDeps {
  store: Pick<Store, 'listConnections' | 'deleteConnection'>;
  traces?: TraceStore;
  post: PostToConnection;
  log?: Logger;
}

export function isGone(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number }; statusCode?: number };
  return e?.name === 'GoneException' || e?.$metadata?.httpStatusCode === 410 || e?.statusCode === 410;
}

/** Split events into `{kind:'events'}` messages no larger than `maxBytes`. An event that alone exceeds it is dropped
 * (and reported) — the client detects the seq gap and re-fetches it over HTTP. */
export function chunkMessages(
  runId: string,
  events: RunEvent[],
  maxBytes = MAX_WS_MESSAGE_BYTES,
): { messages: string[]; dropped: number[] } {
  const envelope = Buffer.byteLength(JSON.stringify({ kind: 'events', runId, events: [] }), 'utf8');
  const messages: string[] = [];
  const dropped: number[] = [];
  let batch: string[] = [];
  let size = envelope;
  const flush = () => {
    if (!batch.length) return;
    messages.push(`{"kind":"events","runId":${JSON.stringify(runId)},"events":[${batch.join(',')}]}`);
    batch = [];
    size = envelope;
  };
  for (const e of events) {
    const s = JSON.stringify(e);
    const bytes = Buffer.byteLength(s, 'utf8');
    if (envelope + bytes > maxBytes) {
      dropped.push(e.seq);
      continue;
    }
    const extra = bytes + (batch.length ? 1 : 0);
    if (size + extra > maxBytes) flush();
    size += bytes + (batch.length ? 1 : 0);
    batch.push(s);
  }
  flush();
  return { messages, dropped };
}

/** Re-exported for type-safety checks in tests. */
export type EventsMessage = Extract<WsServerMessage, { kind: 'events' }>;

export function createFanoutHandler(deps: FanoutDeps) {
  const log = deps.log ?? silentLogger;
  return async (event: StreamEvent): Promise<BatchResponse> => {
    const byRun = new Map<string, { events: RunEvent[]; ids: string[] }>();
    const failures: string[] = [];

    for (const r of event.Records ?? []) {
      const id = r.dynamodb?.SequenceNumber ?? r.eventID ?? '';
      const image = r.dynamodb?.NewImage;
      if (!image) continue;
      try {
        const item = unmarshall(image as never) as Record<string, unknown>;
        if (typeof item.SK !== 'string' || !item.SK.startsWith('EVT#')) continue; // defence in depth
        const e = await itemToEvent(item, deps.traces);
        const g = byRun.get(e.runId) ?? { events: [], ids: [] };
        g.events.push(e);
        g.ids.push(id);
        byRun.set(e.runId, g);
      } catch (err) {
        log.error('fanout: could not decode record', { recordId: id, ...errorFields(err) });
        failures.push(id);
      }
    }

    await Promise.all(
      [...byRun.entries()].map(async ([runId, g]) => {
        const seen = new Set<number>();
        const events = g.events
          .sort((a, b) => a.seq - b.seq)
          .filter((e) => (seen.has(e.seq) ? false : (seen.add(e.seq), true)));
        try {
          const connections = await deps.store.listConnections(runId);
          if (!connections.length) return;
          const { messages, dropped } = chunkMessages(runId, events);
          if (dropped.length)
            log.warn('fanout: event too large for WebSocket, client will re-fetch', { runId, dropped });
          let failed = false;
          await Promise.all(
            connections.map(async (connectionId) => {
              for (const m of messages) {
                try {
                  await deps.post(connectionId, m);
                } catch (err) {
                  if (isGone(err)) {
                    await deps.store.deleteConnection(connectionId);
                    log.info('fanout: purged stale connection', { runId, connectionId });
                  } else {
                    failed = true;
                    log.error('fanout: post failed', { runId, connectionId, ...errorFields(err) });
                  }
                  return;
                }
              }
            }),
          );
          if (failed) failures.push(...g.ids);
          log.info('fanout: delivered', {
            runId,
            seqFrom: events[0]?.seq,
            seqTo: events.at(-1)?.seq,
            connections: connections.length,
            messages: messages.length,
          });
        } catch (err) {
          log.error('fanout: run delivery failed', { runId, ...errorFields(err) });
          failures.push(...g.ids);
        }
      }),
    );

    return {
      batchItemFailures: [...new Set(failures)].filter(Boolean).map((itemIdentifier) => ({ itemIdentifier })),
    };
  };
}
