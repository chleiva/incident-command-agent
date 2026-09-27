/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** Mock-mode services: the real API client and run stream, over the in-browser fake backend. */
import { createServices, type Services } from '../lib/config';
import { MOCK_API_URL, MOCK_WS_URL, MockBackend, type MockBackendOptions } from './mockBackend';

let shared: MockBackend | null = null;

export function mockBackend(opts?: MockBackendOptions): MockBackend {
  if (!shared) {
    const params = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
    shared = new MockBackend({
      autopilot: params?.get('autopilot') === '1',
      timeScale: Number(params?.get('timescale') ?? 1) || 1,
      ...opts,
    });
  }
  return shared;
}

export async function createMockServices(opts?: MockBackendOptions): Promise<Services> {
  const backend = mockBackend(opts);
  return createServices({
    runtime: { apiUrl: MOCK_API_URL, wsUrl: MOCK_WS_URL, auth: { mode: 'none' } },
    transport: backend.transport(),
    mode: 'mock',
    simulateDrop: () => backend.simulateDrop(),
    canRun: (id) => backend.hasRecording(id),
  });
}
