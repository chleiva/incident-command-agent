/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * @ica/api — HTTP router Lambda, WebSocket connect/disconnect/default, stream fan-out, author Lambda wrapper and
 * the local dev server. Lambda entries live in `src/lambda/*` (bundled by infra); everything here is testable
 * with injected dependencies.
 */
export { createApiHandler, startOfDayUtc } from './http/routes';
export { createRouter, matchRoute, principalFromClaims, type RouteTable } from './http/router';
export type { ApiDeps, AuthorInvoker, RunLauncher } from './http/deps';
export type { HttpEvent, HttpResult, JwtClaims } from './http/types';
export { HttpError } from './http/errors';
export { settingsFromEnv, llmConfigFromEnv, type ApiSettings, type AuthMode } from './config/settings';
export {
  buildAppConfig,
  parseBrandPack,
  parseStations,
  selectStations,
  DEFAULT_BRAND,
  FALLBACK_STATIONS,
} from './config/app-config';
export { createConnectHandler, createDisconnectHandler, createDefaultHandler } from './ws/handlers';
export { createFanoutHandler, chunkMessages, MAX_WS_MESSAGE_BYTES } from './ws/fanout';
export { createCognitoVerifier, type TokenVerifier } from './ws/jwt';
export { fakeRun } from './runner/fake-runner';
export {
  InProcessAuthorInvoker,
  InProcessRunLauncher,
  LambdaAuthorInvoker,
  LambdaRunLauncher,
} from './runner/launchers';
export { createLocalApp } from './local/app';
export { createLogger, silentLogger, type Logger } from './util/log';
