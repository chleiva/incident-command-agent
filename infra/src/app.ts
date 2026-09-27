/*
 * Copyright 2026 Ground Incident Coordination Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** Builds the CDK app: DataStack, WebWafStack (us-east-1), WebStack, ApiStack, with cdk-nag AwsSolutions checks. */
import { App, Tags, Validations, type AppProps } from 'aws-cdk-lib';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, loadInfraConfig, type InfraConfig, type LoadConfigOptions } from './config';
import { IcaNagChecks, extraNagSuppressions } from './nag';
import { ApiStack } from './stacks/api-stack';
import { DataStack } from './stacks/data-stack';
import { WebStack } from './stacks/web-stack';
import { WebWafStack } from './stacks/web-waf-stack';

export interface BuiltApp {
  app: App;
  config: InfraConfig;
  data: DataStack;
  /** Absent with `-c cloudfrontWaf=false`. */
  webWaf?: WebWafStack;
  web: WebStack;
  api: ApiStack;
}

export interface BuildAppOptions {
  appProps?: AppProps;
  /** Overrides for config loading (tests pass `envFile: null`). */
  config?: Omit<LoadConfigOptions, 'context'>;
  nag?: boolean;
}

export function stackNames(prefix: string) {
  return {
    data: `${prefix}-Data`,
    webWaf: `${prefix}-WebWaf`,
    web: `${prefix}-Web`,
    api: `${prefix}-Api`,
  };
}

/** cdk.json context (feature flags), so a direct `tsx bin/app.ts` synth matches what the CDK CLI deploys. */
export function cdkJsonContext(): Record<string, unknown> {
  const file = join(REPO_ROOT, 'infra/cdk.json');
  return existsSync(file)
    ? ((JSON.parse(readFileSync(file, 'utf8')) as { context?: Record<string, unknown> }).context ?? {})
    : {};
}

export function buildApp(opts: BuildAppOptions = {}): BuiltApp {
  const app = new App({ ...opts.appProps, context: { ...cdkJsonContext(), ...opts.appProps?.context } });
  const config = loadInfraConfig({ ...opts.config, context: (k) => app.node.tryGetContext(k) });
  const names = stackNames(config.prefix);
  const env = { account: config.account, region: config.region };

  const data = new DataStack(app, names.data, {
    env,
    ephemeral: config.ephemeral,
    webSearch: config.webSearch,
    description: 'Ground Incident Coordination Agent: DynamoDB table, S3 buckets, secret placeholders',
  });
  const webWaf = config.cloudfrontWaf
    ? new WebWafStack(app, names.webWaf, {
        env: { account: config.account, region: 'us-east-1' },
        crossRegionReferences: true,
        description: 'Ground Incident Coordination Agent: CloudFront WAF (us-east-1)',
      })
    : undefined;
  const web = new WebStack(app, names.web, {
    env,
    crossRegionReferences: !!webWaf,
    siteBucket: data.siteBucket,
    webAclArn: webWaf?.webAclArn,
    cognitoDomainPrefix: config.cognitoDomainPrefix,
    webDistDir: config.webDistDir,
    description: 'Ground Incident Coordination Agent: CloudFront distribution and SPA deployment',
  });
  const api = new ApiStack(app, names.api, {
    env,
    config,
    table: data.table,
    tracesBucket: data.tracesBucket,
    knowledgeBucket: data.knowledgeBucket,
    siteBucket: data.siteBucket,
    llmSecret: data.llmSecret,
    searchSecret: data.searchSecret,
    distribution: web.distribution,
    description:
      'Ground Incident Coordination Agent: Cognito, HTTP + WebSocket APIs, Lambdas, WAF, budget, alarms',
  });

  for (const s of [data, webWaf, web, api]) if (s) Tags.of(s).add('project', 'incident-command-agent');
  // OAC on the imported site bucket: the bucket policy is written in DataStack instead (see data-stack.ts).
  Validations.of(web).acknowledge({
    id: 'Construct-Annotations::@aws-cdk/aws-cloudfront-origins:updateImportedBucketPolicyOac',
    reason: "DataStack grants cloudfront.amazonaws.com read access scoped to this account's distributions.",
  });
  if (opts.nag !== false) {
    Validations.of(app).addPlugins(new IcaNagChecks(app, { verbose: true }, extraNagSuppressions(config)));
  }
  return { app, config, data, webWaf, web, api };
}
