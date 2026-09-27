/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** `fanout` Lambda entry: DynamoDB Streams (EVT# rows) → PostToConnection. Env: TABLE_NAME, TRACES_BUCKET, WS_CALLBACK_URL. */
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from '@aws-sdk/client-apigatewaymanagementapi';
import { DynamoStore, S3TraceStore } from '@ica/store';
import { envRequired } from '../util/env';
import { createLogger } from '../util/log';
import { createFanoutHandler, type BatchResponse, type StreamEvent } from '../ws/fanout';

let handle: ((e: StreamEvent) => Promise<BatchResponse>) | null = null;

function build() {
  const env = process.env;
  const traces = new S3TraceStore({ bucket: envRequired(env, 'TRACES_BUCKET') });
  const store = new DynamoStore({ tableName: envRequired(env, 'TABLE_NAME'), traces });
  const client = new ApiGatewayManagementApiClient({ endpoint: envRequired(env, 'WS_CALLBACK_URL') });
  const encoder = new TextEncoder();
  return createFanoutHandler({
    store,
    traces,
    post: async (connectionId, data) => {
      await client.send(
        new PostToConnectionCommand({ ConnectionId: connectionId, Data: encoder.encode(data) }),
      );
    },
    log: createLogger({ fn: 'fanout' }),
  });
}

export async function handler(event: StreamEvent): Promise<BatchResponse> {
  handle ??= build();
  return handle(event);
}
