/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * WebSocket Lambda entries: `connect` ($connect, verifies the Cognito JWT), `disconnect` ($disconnect) and
 * `defaultRoute` ($default, ping). Env: TABLE_NAME, USER_POOL_ID, USER_POOL_CLIENT_ID.
 */
import { DynamoStore } from '@ica/store';
import { envRequired } from '../util/env';
import { createLogger } from '../util/log';
import {
  createConnectHandler,
  createDefaultHandler,
  createDisconnectHandler,
  type WsEvent,
} from '../ws/handlers';
import { createCognitoVerifier } from '../ws/jwt';

const log = createLogger({ fn: 'ws' });
let store: DynamoStore | null = null;
const getStore = () => (store ??= new DynamoStore({ tableName: envRequired(process.env, 'TABLE_NAME') }));

let onConnect: ReturnType<typeof createConnectHandler> | null = null;
export async function connect(event: WsEvent) {
  onConnect ??= createConnectHandler({
    store: getStore(),
    authMode: 'cognito',
    verify: createCognitoVerifier({
      userPoolId: envRequired(process.env, 'USER_POOL_ID'),
      clientId: envRequired(process.env, 'USER_POOL_CLIENT_ID'),
    }),
    log,
  });
  return onConnect(event);
}

let onDisconnect: ReturnType<typeof createDisconnectHandler> | null = null;
export async function disconnect(event: WsEvent) {
  onDisconnect ??= createDisconnectHandler({ store: getStore(), log });
  return onDisconnect(event);
}

const onDefault = createDefaultHandler();
export async function defaultRoute(event: WsEvent) {
  return onDefault(event);
}
