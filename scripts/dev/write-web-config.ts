/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Writes `apps/web/public/config.json` (WebRuntimeConfig, git-ignored) for the Vite dev server:
 *   `local` (npm run dev)     → the local API on :8787, AUTH_MODE=none
 *   `aws`   (npm run dev:aws) → the deployed API, from the Ica-Api stack outputs (Cognito, redirect to :5173)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { WebRuntimeConfigSchema, compileSchema, type WebRuntimeConfig } from '@ica/schema';
import {
  REPO_ROOT,
  awsRegion,
  fail,
  getStackOutputs,
  isMain,
  loadDotEnv,
  requireOutput,
  stackName,
} from '../ops/lib';

export const LOCAL_API_PORT = 8787;
export const VITE_ORIGIN = 'http://localhost:5173';
export const WEB_CONFIG_PATH = join(REPO_ROOT, 'apps/web/public/config.json');

export function localWebConfig(port = LOCAL_API_PORT): WebRuntimeConfig {
  return { apiUrl: `http://localhost:${port}`, wsUrl: `ws://localhost:${port}/ws`, auth: { mode: 'none' } };
}

export function awsWebConfig(outputs: Record<string, string>, stack: string): WebRuntimeConfig {
  const get = (k: string) => requireOutput(outputs, k, stack);
  return {
    apiUrl: get('HttpApiUrl'),
    wsUrl: get('WsApiUrl'),
    auth: {
      mode: 'cognito',
      region: get('Region'),
      userPoolId: get('UserPoolId'),
      clientId: get('UserPoolClientId'),
      domain: get('CognitoDomain'),
      redirectUri: `${VITE_ORIGIN}/`,
    },
  };
}

const validate = compileSchema(WebRuntimeConfigSchema);

export function writeWebConfig(cfg: WebRuntimeConfig, path = WEB_CONFIG_PATH): void {
  const v = validate(cfg);
  if (!v.ok) throw new Error(`invalid web config: ${v.errors.join('; ')}`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`);
}

async function main() {
  loadDotEnv();
  const mode = process.argv[2] ?? 'local';
  if (mode === 'local') {
    writeWebConfig(localWebConfig(Number(process.env.PORT || LOCAL_API_PORT)));
  } else if (mode === 'aws') {
    const stack = stackName('Api');
    writeWebConfig(awsWebConfig(await getStackOutputs(stack, { region: awsRegion() }), stack));
  } else {
    fail('usage: write-web-config.ts local|aws');
  }
  console.log(`✔ wrote apps/web/public/config.json (${mode})`);
}

if (isMain(import.meta.url)) main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
