/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * cdk-nag (AwsSolutions) with justified suppressions. cdk-nag v3 acknowledges granular findings by exact id, and
 * IAM5 finding ids embed CloudFormation export names (which change with the stack prefix), so suppressions are
 * expressed here as (rule regex, construct-path regex, reason) and applied by filtering the pack's report.
 * Every entry below is a deliberate decision; `npm run synth` fails on anything not listed.
 */
import type { IConstruct } from 'constructs';
import { AwsSolutionsChecks, type NagPackProps } from 'cdk-nag';

export interface NagSuppression {
  rule: RegExp;
  path: RegExp;
  reason: string;
}

const OUR_FUNCTIONS = /\/(ApiFn|AuthorFn|RunFn|FanoutFn|WsConnectFn|WsDisconnectFn|WsDefaultFn)\//;
const CDK_BUCKET_DEPLOYMENT = /\/Custom::CDKBucketDeployment[^/]*\//;

export const NAG_SUPPRESSIONS: NagSuppression[] = [
  {
    rule: /^AwsSolutions-DDB3$/,
    path: /\/Table\//,
    reason:
      'PITR deliberately off: run data is ephemeral and the owner wants near-zero idle cost; RETAIN still protects the table.',
  },
  {
    rule: /^AwsSolutions-L1$/,
    path: OUR_FUNCTIONS,
    reason:
      'The specification pins the Lambda runtime to Node.js 22 (LTS); upgrading is a deliberate change.',
  },
  {
    rule: /^AwsSolutions-IAM4\[Policy::.*AWSLambdaBasicExecutionRole\]$/,
    path: /.*/,
    reason:
      "AWSLambdaBasicExecutionRole only allows writing the function's own CloudWatch Logs; functions use dedicated 30-day log groups.",
  },
  {
    rule: /^AwsSolutions-IAM5\[Resource::.*\/index\/\*\]$/,
    path: OUR_FUNCTIONS,
    reason:
      'Query on the single-table GSI1 (runs, scenarios, eval reports, connections by run); the table is ours alone.',
  },
  {
    rule: /^AwsSolutions-IAM5\[Resource::.*\/traces\/\*(\/export\.json)?\]$/,
    path: OUR_FUNCTIONS,
    reason:
      'Trace objects are keyed traces/{runId}/{seq}.json per run; access is limited to that prefix of the private traces bucket.',
  },
  {
    rule: /^AwsSolutions-IAM5\[Resource::.*KnowledgeBucket.*\/\*\]$/,
    path: /\/(AuthorFn|RunFn)\//,
    reason:
      'Read-only access to the knowledge index files (data/index uploaded by kb:upload) in the private knowledge bucket.',
  },
  {
    rule: /^AwsSolutions-IAM5\[Resource::<(RunFn|AuthorFn)[A-F0-9]{8}\.Arn>:\*\]$/,
    path: /\/ApiFn\//,
    reason:
      'lambda:InvokeFunction on the run/author functions including their versions/aliases (grantInvoke default).',
  },
  {
    rule: /^AwsSolutions-IAM5\[Resource::.*@connections\/\*\]$/,
    path: /\/FanoutFn\//,
    reason:
      'execute-api:ManageConnections is scoped to this WebSocket API stage; connection ids are dynamic.',
  },
  {
    rule: /^AwsSolutions-IAM5\[Resource::\*\]$/,
    path: /\/FanoutFn\//,
    reason:
      'dynamodb:ListStreams (required by the DynamoDB event source mapping) does not support resource-level permissions.',
  },
  {
    rule: /^AwsSolutions-IAM5\[Resource::arn:.*:bedrock:\*.*\]$/,
    path: /\/(AuthorFn|RunFn)\//,
    reason:
      'Only when LLM_PROVIDER or the fallback is bedrock: model ids and inference profiles are chosen by config.',
  },
  {
    rule: /^AwsSolutions-(IAM4|IAM5|L1)(\[.*\])?$/,
    path: CDK_BUCKET_DEPLOYMENT,
    reason:
      'CDK-managed BucketDeployment singleton (deploys the SPA and config.json); its role and runtime are owned by aws-cdk-lib.',
  },
  {
    rule: /^AwsSolutions-IAM5\[Resource::\*\]$/,
    path: /\/(DeployWebConfig|DeployIndex|DeployAssets)\/CustomResourceHandler\//,
    reason:
      'CDK-managed BucketDeployment invalidation policy: cloudfront:CreateInvalidation/GetInvalidation do not support resource-level scoping in the construct.',
  },
  {
    rule: /^AwsSolutions-COG2$/,
    path: /\/UserPool\//,
    reason:
      'Spec §11: MFA is optional (TOTP available) for the single admin-created user of this demo deployment.',
  },
  {
    rule: /^AwsSolutions-COG8$/,
    path: /\/UserPool\//,
    reason:
      'Cognito Plus (threat protection) is a paid tier; self sign-up is disabled, the pool has one admin-created user and a WAF.',
  },
  {
    rule: /^AwsSolutions-APIG4$/,
    path: /\/WsApi\//,
    reason:
      'WebSocket auth happens in the $connect Lambda (Cognito JWT verified with aws-jwt-verify); $disconnect/$default are only reachable on an authenticated connection.',
  },
  {
    rule: /^AwsSolutions-APIG1$/,
    path: /\/WsStage\//,
    reason:
      'WebSocket stage access logs need the account-wide API Gateway CloudWatch role (a global side effect); connect/disconnect/fan-out Lambdas log every connection.',
  },
  {
    rule: /^AwsSolutions-S1$/,
    path: /\/(SiteBucket|KnowledgeBucket|TracesBucket)\//,
    reason:
      'Private, SSE-S3, SSL-only buckets of a single-user demo; server access logs would add a logging bucket and cost.',
  },
  {
    rule: /^AwsSolutions-SMG4$/,
    path: /\/(LlmSecret|SearchSecret)\//,
    reason:
      'Third-party provider API keys cannot be rotated by a Lambda; rotate them in the provider console and re-run secrets:set.',
  },
  {
    rule: /^AwsSolutions-CFR1$/,
    path: /\/Distribution\//,
    reason: 'No geographic restriction requirement; access is gated by Cognito and the WAF.',
  },
  {
    rule: /^AwsSolutions-CFR3$/,
    path: /\/Distribution\//,
    reason:
      'CloudFront standard logs need a logging bucket with ACLs; not justified for a single-user demo (WAF metrics are enabled).',
  },
  {
    rule: /^AwsSolutions-CFR4$/,
    path: /\/Distribution\//,
    reason:
      'No custom domain: the default *.cloudfront.net certificate fixes the viewer security policy. Add a certificate to raise it.',
  },
];

/** Suppressions that only apply to explicit opt-outs. */
export function extraNagSuppressions(config: { cloudfrontWaf: boolean }): NagSuppression[] {
  return config.cloudfrontWaf
    ? []
    : [
        {
          rule: /^AwsSolutions-CFR2$/,
          path: /\/Distribution\//,
          reason:
            'Explicit opt-out (-c cloudfrontWaf=false) to save the WebACL base cost; Cognito still gates the app.',
        },
      ];
}

export function isSuppressed(
  ruleName: string,
  constructPath: string,
  rules = NAG_SUPPRESSIONS,
): NagSuppression | null {
  return rules.find((r) => r.rule.test(ruleName) && r.path.test(`/${constructPath}/`)) ?? null;
}

/** AwsSolutions checks minus the justified suppressions above. */
export class IcaNagChecks extends AwsSolutionsChecks {
  private readonly suppressions: NagSuppression[];

  constructor(scope?: IConstruct, props?: NagPackProps, extra: NagSuppression[] = []) {
    super(scope, props);
    this.suppressions = [...NAG_SUPPRESSIONS, ...extra];
  }

  override validateScope(scope: IConstruct): ReturnType<AwsSolutionsChecks['validateScope']> {
    const report = super.validateScope(scope);
    const violations = report.violations
      .map((v) => ({
        ...v,
        violatingResources: v.violatingResources.filter((r) => {
          const res = r as { constructPath?: string; templatePath?: string };
          return !isSuppressed(v.ruleName, res.constructPath ?? res.templatePath ?? '', this.suppressions);
        }),
      }))
      .filter((v) => v.violatingResources.length > 0);
    return { ...report, success: violations.length === 0, violations };
  }
}
