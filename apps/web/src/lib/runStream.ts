/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * The event-consumption algorithm of spec §4, exactly:
 *  1. hydrate with `GET /runs/{id}/events?after=0`, paging until `hasMore=false`;
 *  2. open the WebSocket;
 *  3. apply events by increasing seq, dropping duplicates; a gap triggers a re-fetch from the last contiguous seq;
 *  4. on a WebSocket drop, report "reconnecting" and poll `GET …/events?after=` every 2 s until the socket is back
 *     (reconnect attempts back off exponentially);
 *  5. on reconnect, report "live" again (the UI shows a toast) and catch up.
 * `onEvents` only ever receives contiguous, strictly increasing, de-duplicated batches.
 */
import type { ListEventsResponse, RunEvent, WsServerMessage } from '@ica/schema/browser';
import type { SocketLike } from './transport';

export type StreamStatus = 'idle' | 'hydrating' | 'live' | 'reconnecting' | 'closed';

export interface Timers {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (h: unknown) => void;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (h: unknown) => void;
}

const defaultTimers: Timers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: (h) => globalThis.clearInterval(h as ReturnType<typeof setInterval>),
};

export interface RunStreamOptions {
  runId: string;
  listEvents: (runId: string, after: number) => Promise<ListEventsResponse>;
  /** Builds the socket URL (with token) and opens it. */
  openSocket: () => Promise<SocketLike> | SocketLike;
  onEvents: (events: RunEvent[]) => void;
  onStatus?: (status: StreamStatus, previous: StreamStatus) => void;
  onError?: (err: unknown) => void;
  onReconnected?: () => void;
  /** Start after this seq (e.g. when the store already holds events). Default 0. */
  afterSeq?: number;
  pollIntervalMs?: number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  timers?: Timers;
}

export class RunStream {
  private lastSeq: number;
  private readonly pending = new Map<number, RunEvent>();
  private socket: SocketLike | null = null;
  private status: StreamStatus = 'idle';
  private stopped = false;
  private fetching: Promise<void> | null = null;
  private refetchAgain = false;
  private pollHandle: unknown = null;
  private reconnectHandle: unknown = null;
  private attempts = 0;
  private readonly t: Timers;

  constructor(private readonly o: RunStreamOptions) {
    this.lastSeq = o.afterSeq ?? 0;
    this.t = o.timers ?? defaultTimers;
  }

  get seq(): number {
    return this.lastSeq;
  }

  get state(): StreamStatus {
    return this.status;
  }

  async start(): Promise<void> {
    this.setStatus('hydrating');
    try {
      await this.catchUp();
    } catch (err) {
      this.o.onError?.(err);
    }
    if (this.stopped) return;
    await this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.stopPolling();
    if (this.reconnectHandle !== null) this.t.clearTimeout(this.reconnectHandle);
    this.reconnectHandle = null;
    const s = this.socket;
    this.socket = null;
    if (s) {
      s.onclose = null;
      s.onmessage = null;
      s.onerror = null;
      s.close();
    }
    this.setStatus('closed');
  }

  /** Accept events from any source (page or push), in any order, possibly duplicated. */
  ingest(events: readonly RunEvent[]): void {
    if (this.stopped) return;
    for (const e of events) {
      if (e.runId !== this.o.runId || e.seq <= this.lastSeq) continue;
      this.pending.set(e.seq, e);
    }
    const ready: RunEvent[] = [];
    while (this.pending.has(this.lastSeq + 1)) {
      const next = this.pending.get(this.lastSeq + 1)!;
      this.pending.delete(next.seq);
      ready.push(next);
      this.lastSeq = next.seq;
    }
    if (ready.length) this.o.onEvents(ready);
    if (this.pending.size > 0) void this.refetch();
  }

  /** Re-fetch from the last contiguous seq (single flight; coalesces concurrent requests). */
  refetch(): Promise<void> {
    if (this.fetching) {
      this.refetchAgain = true;
      return this.fetching;
    }
    this.fetching = (async () => {
      try {
        do {
          this.refetchAgain = false;
          await this.catchUp();
        } while (this.refetchAgain && !this.stopped);
      } catch (err) {
        this.o.onError?.(err);
      } finally {
        this.fetching = null;
      }
    })();
    return this.fetching;
  }

  private async catchUp(): Promise<void> {
    for (;;) {
      if (this.stopped) return;
      const page = await this.o.listEvents(this.o.runId, this.lastSeq);
      this.ingest(page.events);
      if (!page.hasMore || page.events.length === 0) return;
    }
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    let socket: SocketLike;
    try {
      socket = await this.o.openSocket();
    } catch (err) {
      this.o.onError?.(err);
      this.onDrop();
      return;
    }
    if (this.stopped) {
      socket.close();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      const wasReconnecting = this.status === 'reconnecting';
      this.attempts = 0;
      this.stopPolling();
      this.setStatus('live');
      // Anything that happened while we were away (or between hydrate and open).
      void this.refetch();
      if (wasReconnecting) this.o.onReconnected?.();
    };
    socket.onmessage = (ev) => {
      let msg: WsServerMessage;
      try {
        msg = JSON.parse(String(ev.data)) as WsServerMessage;
      } catch {
        return;
      }
      if (msg.kind === 'events' && msg.runId === this.o.runId) this.ingest(msg.events);
    };
    socket.onerror = () => {
      /* onclose follows */
    };
    socket.onclose = () => {
      if (this.socket === socket) this.socket = null;
      this.onDrop();
    };
  }

  private onDrop(): void {
    if (this.stopped) return;
    this.setStatus('reconnecting');
    this.startPolling();
    const delay = Math.min(
      this.o.reconnectMaxMs ?? 30_000,
      (this.o.reconnectBaseMs ?? 1_000) * 2 ** this.attempts,
    );
    this.attempts += 1;
    if (this.reconnectHandle !== null) this.t.clearTimeout(this.reconnectHandle);
    this.reconnectHandle = this.t.setTimeout(() => {
      this.reconnectHandle = null;
      void this.connect();
    }, delay);
  }

  private startPolling(): void {
    if (this.pollHandle !== null) return;
    this.pollHandle = this.t.setInterval(() => void this.refetch(), this.o.pollIntervalMs ?? 2_000);
  }

  private stopPolling(): void {
    if (this.pollHandle !== null) this.t.clearInterval(this.pollHandle);
    this.pollHandle = null;
  }

  private setStatus(s: StreamStatus): void {
    if (s === this.status) return;
    const prev = this.status;
    this.status = s;
    this.o.onStatus?.(s, prev);
  }
}
