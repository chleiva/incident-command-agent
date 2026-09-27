/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * The only I/O seam of the SPA: `fetch` plus a WebSocket factory. Real mode uses the browser's; mock mode swaps in
 * the in-browser fake backend. The API client and the run stream are identical in mock, local and AWS modes.
 */

/** The subset of the WebSocket API the client uses. */
export interface SocketLike {
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}

export interface Transport {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  openSocket: (url: string) => SocketLike;
}

export const browserTransport: Transport = {
  fetch: (input, init) => globalThis.fetch(input, init),
  openSocket: (url) => new WebSocket(url) as unknown as SocketLike,
};
