/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * `api` Lambda entry: API Gateway HTTP API (payload v2.0, JWT authorizer) → router. Built once per container.
 * `process.env.BRAND_PACK` and `process.env.STATIONS_JSON` are replaced at bundle time by infra (esbuild define).
 */
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { LambdaClient } from '@aws-sdk/client-lambda';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { screenInput, screenInputFast } from '@ica/run';
import { publicScenarios } from '@ica/scenarios';
import { DEFAULT_BRAND, FALLBACK_STATIONS, parseBrandPack, parseStations } from '../config/app-config';
import { settingsFromEnv } from '../config/settings';
import { createApiHandler } from '../http/routes';
import { createCognitoUserNameResolver } from '../http/user-names';
import type { HttpEvent, HttpResult } from '../http/types';
import { LambdaAuthorInvoker, LambdaRunLauncher } from '../runner/launchers';
import { envRequired } from '../util/env';
import { createLogger } from '../util/log';
import { awsCore } from './aws-deps';

let handle: ((e: HttpEvent) => Promise<HttpResult>) | null = null;

function build() {
  const env = process.env;
  const settings = settingsFromEnv(env);
  if (settings.authMode !== 'cognito') throw new Error('AUTH_MODE=none is local-only and never deployable');
  const brandRaw = process.env.BRAND_PACK;
  const stationsRaw = process.env.STATIONS_JSON;
  const brand = brandRaw ? parseBrandPack(brandRaw) : DEFAULT_BRAND;
  const stations = stationsRaw ? parseStations(stationsRaw) : FALLBACK_STATIONS;
  const { store, traces } = awsCore(env);
  const lambda = new LambdaClient({});
  const s3 = new S3Client({});
  const bucket = envRequired(env, 'TRACES_BUCKET');
  const log = createLogger({ fn: 'api' });
  // Approver names: the access token has no email/name claim, so look the user up (cached per container).
  const userPoolId = env.USER_POOL_ID;
  const resolveUserName = userPoolId
    ? createCognitoUserNameResolver({ client: new CognitoIdentityProviderClient({}), userPoolId, log })
    : undefined;
  return createApiHandler({
    store,
    traces,
    launcher: new LambdaRunLauncher(lambda, envRequired(env, 'RUN_FUNCTION_NAME')),
    author: new LambdaAuthorInvoker(lambda, envRequired(env, 'AUTHOR_FUNCTION_NAME')),
    screen: screenInput,
    // Request path: regex screening only (no LLM classifier call inside the 29 s API Gateway window).
    screenFast: screenInputFast,
    publicScenarios,
    settings,
    appConfigSource: async () => ({ brand, stations }),
    presign: (key) =>
      getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: 900 }),
    log,
    ...(resolveUserName ? { resolveUserName } : {}),
  });
}

export async function handler(event: HttpEvent): Promise<HttpResult> {
  handle ??= build();
  return handle(event);
}
