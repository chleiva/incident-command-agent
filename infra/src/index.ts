/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** @ica/infra — the CDK app (DataStack, WebWafStack, WebStack, ApiStack). Entry: bin/app.ts. */
export { buildApp, stackNames, type BuiltApp } from './app';
export { loadInfraConfig, LAMBDA_ENV_ALLOW_LIST, type InfraConfig } from './config';
