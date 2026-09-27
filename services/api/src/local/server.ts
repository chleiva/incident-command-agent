/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * `npm run dev -w @ica/api`: the local dev server on :8787 (spec §12). MemoryStore + MemoryEventBus + FsTraceStore
 * (.local/) + EnvSecretStore (.env), `executeRun`/`runAuthor` in-process, AUTH_MODE=none.
 *
 * Env: PORT (8787), LOCAL_HOST (127.0.0.1), LOCAL_PERSIST (e.g. .local/store.json: snapshot on exit, restored on
 * start), LOCAL_RUNNER (auto | real | fake; auto falls back to the fixture-replay fake runner while task 02's
 * `executeRun` is a stub), LOCAL_FAKE_STEP_MS.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeRun, loadKnowledgeIndex, runAuthor, screenInput, screenInputFast } from '@ica/run';
import { publicScenarios } from '@ica/scenarios';
import {
  simAutoApproveAfterMsFromEnv,
  validateScenario,
  type KnowledgeIndex,
  type RunDeps,
} from '@ica/schema';
import {
  EnvSecretStore,
  FsTraceStore,
  MemoryEventBus,
  MemoryStore,
  type MemoryStoreSnapshot,
} from '@ica/store';
import { DEFAULT_BRAND, FALLBACK_STATIONS, parseBrandPack, parseStations } from '../config/app-config';
import { llmConfigFromEnv, settingsFromEnv } from '../config/settings';
import { InProcessAuthorInvoker, InProcessRunLauncher, type LocalRunnerMode } from '../runner/launchers';
import { envNum, envOpt, envStr, type Env } from '../util/env';
import { createLogger } from '../util/log';
import { createLocalApp } from './app';

export const REPO_ROOT = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));

function loadDotEnv(): void {
  const file = join(REPO_ROOT, '.env');
  if (existsSync(file)) process.loadEnvFile(file); // never overrides variables already set
}

function readJson(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

export function knowledgeDir(root = REPO_ROOT): string {
  const candidates = [
    join(root, 'data/index'),
    join(root, 'data/fixtures/index'),
    join(root, 'data/fixtures'),
  ];
  return candidates.find((p) => existsSync(p)) ?? candidates[0];
}

async function main() {
  loadDotEnv();
  const env: Env = { ...process.env, AUTH_MODE: 'none', CORS_ORIGINS: '*' };
  const log = createLogger({ fn: 'local' });
  const settings = settingsFromEnv(env);

  const bus = new MemoryEventBus();
  const persistPath = envOpt(env, 'LOCAL_PERSIST') ? resolve(REPO_ROOT, env.LOCAL_PERSIST!) : null;
  let store = new MemoryStore({ bus });
  if (persistPath && existsSync(persistPath)) {
    const snap = JSON.parse(readFileSync(persistPath, 'utf8')) as MemoryStoreSnapshot;
    store = MemoryStore.fromSnapshot(snap, { bus });
    log.info('restored local store', { path: persistPath, runs: snap.runs.length });
  }

  // Private scenarios (git-ignored) are loaded into the store, like `npm run scenarios:push` does in AWS.
  const privDir = join(REPO_ROOT, 'scenarios/private');
  if (existsSync(privDir)) {
    for (const f of readdirSync(privDir).filter((n) => n.endsWith('.json'))) {
      const v = validateScenario(JSON.parse(readFileSync(join(privDir, f), 'utf8')));
      if (v.ok) await store.putScenario({ ...v.value, visibility: 'private' });
      else log.warn('skipping invalid private scenario', { file: f, errors: v.errors.slice(0, 3) });
    }
  }

  const traces = new FsTraceStore(join(REPO_ROOT, '.local'));
  const secrets = new EnvSecretStore();
  let knowledge: Promise<KnowledgeIndex> | null = null;
  const deps = async (): Promise<RunDeps> => {
    knowledge ??= loadKnowledgeIndex({ source: 'fs', path: knowledgeDir() });
    return {
      store,
      traces,
      knowledge: await knowledge,
      llm: llmConfigFromEnv(env),
      secrets,
      bus,
      simAutoApproveAfterMs: simAutoApproveAfterMsFromEnv(env),
    };
  };

  const launcher = new InProcessRunLauncher({
    store,
    executeRun,
    deps,
    mode: envStr(env, 'LOCAL_RUNNER', 'auto') as LocalRunnerMode,
    fakeStepMs: envNum(env, 'LOCAL_FAKE_STEP_MS', 400),
    log,
  });

  const brandRaw =
    readJson(join(REPO_ROOT, 'config/brand.local.json')) ??
    readJson(join(REPO_ROOT, 'config/brand.default.json'));
  const stationsRaw = readJson(join(REPO_ROOT, 'data/airports/stations.json'));
  const brand = brandRaw ? parseBrandPack(brandRaw) : DEFAULT_BRAND;
  const stations = stationsRaw ? parseStations(stationsRaw) : FALLBACK_STATIONS;

  const app = createLocalApp({
    store,
    bus,
    traces,
    launcher,
    author: new InProcessAuthorInvoker(runAuthor, deps, {
      store,
      publicIds: publicScenarios.map((s) => s.id),
      log,
    }),
    screen: screenInput,
    screenFast: screenInputFast,
    publicScenarios,
    settings,
    appConfigSource: async () => ({ brand, stations }),
    log,
  });

  const port = await app.listen(envNum(env, 'PORT', 8787), envStr(env, 'LOCAL_HOST', '127.0.0.1'));
  log.info('local API ready', {
    http: `http://localhost:${port}`,
    ws: `ws://localhost:${port}/ws?runId=`,
    runner: envStr(env, 'LOCAL_RUNNER', 'auto'),
    llm: `${settings.llm.provider}/${settings.llm.model}`,
    persist: persistPath ?? 'off',
  });

  const save = () => {
    if (!persistPath) return;
    mkdirSync(dirname(persistPath), { recursive: true });
    writeFileSync(persistPath, JSON.stringify(store.snapshot()));
  };
  const timer = persistPath ? setInterval(save, 10_000) : null;
  timer?.unref();

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    if (timer) clearInterval(timer);
    await launcher.close();
    save();
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(JSON.stringify({ level: 'error', msg: 'local server failed to start', err: String(err) }));
    process.exit(1);
  });
}
