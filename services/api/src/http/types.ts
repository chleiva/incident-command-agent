/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * The subset of the API Gateway HTTP API payload v2.0 event/result the router uses (kept local to avoid a
 * dependency on @types/aws-lambda). The local dev server builds the same shape from Node requests.
 */

export interface JwtClaims {
  sub?: string;
  email?: string;
  username?: string;
  'cognito:username'?: string;
  [claim: string]: unknown;
}

export interface HttpEvent {
  version?: string;
  routeKey?: string;
  rawPath: string;
  rawQueryString?: string;
  headers?: Record<string, string | undefined>;
  queryStringParameters?: Record<string, string | undefined>;
  pathParameters?: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
  requestContext: {
    requestId?: string;
    http: { method: string; path?: string; sourceIp?: string };
    authorizer?: { jwt?: { claims?: JwtClaims; scopes?: string[] } };
  };
}

export interface HttpResult {
  statusCode: number;
  headers?: Record<string, string>;
  body?: string;
  isBase64Encoded?: boolean;
}
