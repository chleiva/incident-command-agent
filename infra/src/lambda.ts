/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** One place for Lambda defaults: Node 22, arm64, esbuild ESM bundles with source maps, 30-day log retention. */
import { join } from 'node:path';
import { type Duration, type RemovalPolicy } from 'aws-cdk-lib';
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';

export interface IcaFunctionProps {
  repoRoot: string;
  /** Entry relative to the repo root, e.g. `services/api/src/lambda/http.ts`. */
  entry: string;
  handler?: string;
  memorySize: number;
  timeout: Duration;
  environment?: Record<string, string>;
  /** Compile-time constants (esbuild define), e.g. `process.env.BRAND_PACK`. Not subject to the 4 KB env limit. */
  define?: Record<string, string>;
  reservedConcurrentExecutions?: number;
  /** Packages installed next to the bundle instead of being bundled (native modules). */
  nodeModules?: string[];
  /** Packages left out of the bundle entirely (only reached through a guarded dynamic `import()`). */
  externalModules?: string[];
  description?: string;
  removalPolicy: RemovalPolicy;
}

/** ESM bundles still meet CommonJS dependencies that call `require`; give them one. */
const REQUIRE_SHIM =
  "import { createRequire as __icaCreateRequire } from 'node:module'; const require = __icaCreateRequire(import.meta.url);";

export class IcaFunction extends NodejsFunction {
  constructor(scope: Construct, id: string, props: IcaFunctionProps) {
    const logGroup = new LogGroup(scope, `${id}Logs`, {
      retention: RetentionDays.ONE_MONTH,
      removalPolicy: props.removalPolicy,
    });
    super(scope, id, {
      entry: join(props.repoRoot, props.entry),
      handler: props.handler ?? 'handler',
      description: props.description,
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      memorySize: props.memorySize,
      timeout: props.timeout,
      reservedConcurrentExecutions: props.reservedConcurrentExecutions,
      logGroup,
      projectRoot: props.repoRoot,
      depsLockFilePath: join(props.repoRoot, 'package-lock.json'),
      environment: { NODE_OPTIONS: '--enable-source-maps', ...props.environment },
      bundling: {
        format: OutputFormat.ESM,
        target: 'node22',
        mainFields: ['module', 'main'],
        sourceMap: true,
        sourcesContent: false,
        minify: true,
        banner: REQUIRE_SHIM,
        // Bundle the AWS SDK too: pinned versions instead of whatever the runtime ships.
        externalModules: props.externalModules ?? [],
        nodeModules: props.nodeModules?.length ? props.nodeModules : undefined,
        define: props.define,
      },
    });
  }
}
