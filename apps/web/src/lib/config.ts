/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Boot configuration. `/config.json` (WebRuntimeConfig, next to the SPA) is the only switch between local, AWS and
 * mock modes; then `GET /config` gives the brand pack (falling back to the bundled Accent Air defaults, FR-11).
 */
import type { AppConfig, WebRuntimeConfig } from '@ica/schema/browser';
import { createApiClient, type ApiClient } from './api';
import { createAuth, socketUrl, type AuthSession } from './auth';
import { DEFAULT_APP_CONFIG, applyBrand, withDefaults } from './brand';
import { browserTransport, type Transport } from './transport';

export const IS_MOCK = import.meta.env.VITE_MOCK === '1';

/** Used when `/config.json` is missing (plain `vite` next to `npm run dev`'s API server). */
export const LOCAL_RUNTIME_CONFIG: WebRuntimeConfig = {
  apiUrl: 'http://localhost:8787',
  wsUrl: 'ws://localhost:8787/ws',
  auth: { mode: 'none' },
};

export interface Services {
  runtime: WebRuntimeConfig;
  app: AppConfig;
  api: ApiClient;
  auth: AuthSession;
  transport: Transport;
  mode: 'mock' | 'live';
  /** Opens the run's WebSocket (with the token when Cognito is on). */
  openRunSocket(runId: string): Promise<ReturnType<Transport['openSocket']>>;
  /** Mock-mode demo aid (drops the WebSocket to show the reconnect path). */
  simulateDrop?: () => void;
  /** Mock mode: whether a scenario has a recording (others need the local dev server). */
  canRun?: (scenarioId: string) => boolean;
}

export async function loadRuntimeConfig(transport: Transport = browserTransport): Promise<WebRuntimeConfig> {
  try {
    const res = await transport.fetch('/config.json', { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`config.json ${res.status}`);
    const cfg = (await res.json()) as WebRuntimeConfig;
    if (!cfg.apiUrl || !cfg.wsUrl || !cfg.auth) throw new Error('config.json is incomplete');
    return cfg;
  } catch (err) {
    console.warn('config.json unavailable, using local defaults', err);
    return LOCAL_RUNTIME_CONFIG;
  }
}

export async function createServices(opts: {
  runtime: WebRuntimeConfig;
  transport: Transport;
  mode: 'mock' | 'live';
  simulateDrop?: () => void;
  canRun?: (scenarioId: string) => boolean;
}): Promise<Services> {
  const auth = await createAuth(opts.runtime);
  const api = createApiClient({
    baseUrl: opts.runtime.apiUrl,
    transport: opts.transport,
    getToken: () => auth.getToken(),
  });
  let app: AppConfig = DEFAULT_APP_CONFIG;
  try {
    app = withDefaults(await api.getConfig());
  } catch (err) {
    console.warn('GET /config failed, using the bundled brand pack', err);
  }
  if (typeof document !== 'undefined') applyBrand(app.brand);
  return {
    runtime: opts.runtime,
    app,
    api,
    auth,
    transport: opts.transport,
    mode: opts.mode,
    simulateDrop: opts.simulateDrop,
    canRun: opts.canRun,
    openRunSocket: async (runId) =>
      opts.transport.openSocket(socketUrl(opts.runtime.wsUrl, runId, await auth.getToken())),
  };
}

/** Boot the app services for the current build (mock or live). */
export async function bootServices(): Promise<Services> {
  if (IS_MOCK) {
    const { createMockServices } = await import('../mocks/services');
    return createMockServices();
  }
  const runtime = await loadRuntimeConfig();
  return createServices({ runtime, transport: browserTransport, mode: 'live' });
}
