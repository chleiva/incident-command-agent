/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ListEventsResponse, RunEvent } from '@ica/schema/browser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RECORDINGS } from '../mocks/recordings';
import { RunStream, type StreamStatus } from './runStream';
import type { SocketLike } from './transport';

const RUN = RECORDINGS[0]!.agent[0]!.runId;
const ALL: RunEvent[] = RECORDINGS[0]!.agent.slice(0, 60);
const ev = (from: number, to: number) => ALL.slice(from - 1, to);

class FakeSocket implements SocketLike {
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null;
  closed = false;
  send() {}
  close() {
    this.closed = true;
  }
  open() {
    this.onopen?.({});
  }
  push(events: RunEvent[]) {
    this.onmessage?.({ data: JSON.stringify({ kind: 'events', runId: RUN, events }) });
  }
  drop() {
    this.onclose?.({});
  }
}

/** A fake server holding the "stored" log; pages of `pageSize`. */
function fakeServer(pageSize = 25) {
  let stored = ev(1, 30);
  const calls: number[] = [];
  return {
    calls,
    setStored: (events: RunEvent[]) => (stored = events),
    listEvents: vi.fn(async (_runId: string, after: number): Promise<ListEventsResponse> => {
      calls.push(after);
      const rest = stored.filter((e) => e.seq > after);
      const events = rest.slice(0, pageSize);
      return { events, lastSeq: stored.at(-1)?.seq ?? 0, hasMore: rest.length > pageSize };
    }),
  };
}

function setup(pageSize = 25) {
  const server = fakeServer(pageSize);
  const sockets: FakeSocket[] = [];
  const received: RunEvent[] = [];
  const statuses: StreamStatus[] = [];
  const reconnected = vi.fn();
  const stream = new RunStream({
    runId: RUN,
    listEvents: server.listEvents,
    openSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    onEvents: (batch) => received.push(...batch),
    onStatus: (s) => statuses.push(s),
    onReconnected: reconnected,
  });
  return { server, sockets, received, statuses, stream, reconnected };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));
const seqs = (xs: RunEvent[]) => xs.map((e) => e.seq);
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

describe('RunStream (spec §4 event consumption)', () => {
  it('hydrates by paging until hasMore=false, then opens the socket', async () => {
    const t = setup(10);
    await t.stream.start();
    expect(t.server.calls).toEqual([0, 10, 20]);
    expect(seqs(t.received)).toEqual(range(1, 30));
    expect(t.sockets).toHaveLength(1);
    t.sockets[0]!.open();
    await flush();
    expect(t.statuses).toContain('live');
    t.stream.stop();
  });

  it('drops duplicates from pushes and overlapping pages', async () => {
    const t = setup();
    await t.stream.start();
    t.sockets[0]!.open();
    await flush();
    t.sockets[0]!.push(ev(25, 32));
    t.sockets[0]!.push(ev(31, 33));
    t.sockets[0]!.push(ev(33, 33));
    expect(seqs(t.received)).toEqual(range(1, 33));
    t.stream.stop();
  });

  it('re-orders an out-of-order batch without a fetch when it is contiguous', async () => {
    const t = setup();
    await t.stream.start();
    t.sockets[0]!.open();
    await flush();
    const callsBefore = t.server.calls.length;
    t.sockets[0]!.push([...ev(31, 34)].reverse());
    expect(seqs(t.received)).toEqual(range(1, 34));
    await flush();
    expect(t.server.calls.length).toBe(callsBefore);
    t.stream.stop();
  });

  it('a gap triggers a re-fetch from the last contiguous seq, then applies the held events in order', async () => {
    const t = setup();
    await t.stream.start();
    t.sockets[0]!.open();
    await flush();
    t.server.setStored(ev(1, 40));
    t.sockets[0]!.push(ev(36, 40)); // 31..35 missing
    expect(seqs(t.received)).toEqual(range(1, 30));
    await flush();
    await flush();
    expect(t.server.calls.at(-1)).toBe(30);
    expect(seqs(t.received)).toEqual(range(1, 40));
    t.stream.stop();
  });

  describe('reconnect', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('polls every 2 s while the socket is down, reconnects with backoff and reports it', async () => {
      const t = setup();
      await t.stream.start();
      t.sockets[0]!.open();
      await vi.advanceTimersByTimeAsync(0);
      t.sockets[0]!.drop();
      expect(t.stream.state).toBe('reconnecting');
      const before = t.server.calls.length;
      t.server.setStored(ev(1, 36));
      await vi.advanceTimersByTimeAsync(2_000);
      expect(t.server.calls.length).toBeGreaterThan(before);
      expect(seqs(t.received)).toEqual(range(1, 36));
      // First reconnect attempt after 1 s: a new socket that fails immediately.
      expect(t.sockets).toHaveLength(2);
      t.sockets[1]!.drop();
      // Backoff: next attempt after 2 s.
      await vi.advanceTimersByTimeAsync(1_900);
      expect(t.sockets).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(200);
      expect(t.sockets).toHaveLength(3);
      t.server.setStored(ev(1, 38));
      t.sockets[2]!.open();
      await vi.advanceTimersByTimeAsync(0);
      expect(t.stream.state).toBe('live');
      expect(t.reconnected).toHaveBeenCalledTimes(1);
      expect(seqs(t.received)).toEqual(range(1, 38));
      // Polling stopped.
      const calls = t.server.calls.length;
      await vi.advanceTimersByTimeAsync(6_000);
      expect(t.server.calls.length).toBe(calls);
      t.stream.stop();
    });
  });
});
