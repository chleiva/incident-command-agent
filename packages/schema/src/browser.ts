/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * `@ica/schema/browser` (addition, task 05): everything in `@ica/schema` except the Ajv validators.
 * `validate.ts` compiles every schema at import time (Ajv code generation via `new Function`), which the SPA must
 * not pay for on first paint (and which a strict CSP forbids). Browser code imports types, constants and the shared
 * reducer from here; tests and servers keep using `@ica/schema`.
 */
export * from './ids';
export * from './common';
export * from './scenario';
export * from './systems';
export * from './kpi';
export * from './events';
export * from './reducer';
export * from './runtime';
export * from './persistence';
export * from './api';
