/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** CDK assertions (fine-grained + snapshots) for every stack, and the cdk-nag gate. No AWS credentials needed. */
import { API_ROUTES } from '@ica/schema';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type BuiltApp } from './app';
import { LOCAL_EMBEDDER_PKG, runtimeEmbeddingEnv } from './stacks/api-stack';
import { IcaNagChecks, extraNagSuppressions } from './nag';

const DUMMY_ENV = {
  LLM_PROVIDER: 'anthropic',
  LLM_MODEL: 'claude-sonnet-5',
  ALERT_EMAIL: 'ops@example.com',
  COGNITO_DOMAIN_PREFIX: 'ica-test-prefix',
  ANTHROPIC_API_KEY: 'dummy-provider-key-must-not-leak',
  MAX_RUNS_PER_DAY: '20',
  FEATURE_WEB_SEARCH: 'true',
};

function build(context: Record<string, unknown> = {}, env: Record<string, string> = DUMMY_ENV): BuiltApp {
  return buildApp({
    // Skip esbuild bundling in unit tests (npm run synth bundles for real).
    appProps: { context: { 'aws:cdk:bundling-stacks': [], ...context } },
    config: { envFile: null, processEnv: env },
  });
}

/** Asset hashes change with every source edit: normalise them out of snapshots. */
function normalised(t: Template): unknown {
  return JSON.parse(
    JSON.stringify(t.toJSON())
      .replace(/[a-f0-9]{64}(\.zip|\.json)?/g, 'ASSET_HASH')
      .replace(/"S3Key":"[^"]+"/g, '"S3Key":"ASSET"'),
  );
}

let built: BuiltApp;
let data: Template;
let api: Template;
let web: Template;
let waf: Template;

beforeAll(() => {
  // Opt-in features on, so every optional construct is asserted; lean defaults are asserted separately below.
  built = build({ cloudfrontWaf: 'true', monitoring: 'true' });
  data = Template.fromStack(built.data);
  api = Template.fromStack(built.api);
  web = Template.fromStack(built.web);
  waf = Template.fromStack(built.webWaf!);
}, 60_000);

describe('DataStack', () => {
  it('has the S3 Vectors bucket + index (1536, cosine, float32, hash non-filterable), retained by default', () => {
    data.resourceCountIs('AWS::S3Vectors::VectorBucket', 1);
    data.hasResource('AWS::S3Vectors::VectorBucket', {
      DeletionPolicy: 'Retain',
      Properties: { EncryptionConfiguration: { SseType: 'AES256' } },
    });
    data.hasResource('AWS::S3Vectors::Index', {
      DeletionPolicy: 'Retain',
      Properties: Match.objectLike({
        Dimension: 1536,
        DistanceMetric: 'cosine',
        DataType: 'float32',
        MetadataConfiguration: { NonFilterableMetadataKeys: ['hash'] },
      }),
    });
    const outputs = Object.keys(data.toJSON().Outputs ?? {});
    for (const o of ['VectorBucketName', 'VectorIndexName', 'VectorIndexArn']) expect(outputs).toContain(o);
    const eph = Template.fromStack(build({ ephemeral: 'true' }).data);
    eph.hasResource('AWS::S3Vectors::Index', { DeletionPolicy: 'Delete' });
    eph.hasResource('AWS::S3Vectors::VectorBucket', { DeletionPolicy: 'Delete' });
  });

  it('has the single table with stream, TTL, no PITR and GSI1 (projection ALL), retained by default', () => {
    data.hasResource('AWS::DynamoDB::Table', {
      DeletionPolicy: 'Retain',
      Properties: Match.objectLike({
        KeySchema: [
          { AttributeName: 'PK', KeyType: 'HASH' },
          { AttributeName: 'SK', KeyType: 'RANGE' },
        ],
        BillingMode: 'PAY_PER_REQUEST',
        StreamSpecification: { StreamViewType: 'NEW_IMAGE' },
        TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: false },
        GlobalSecondaryIndexes: [
          {
            IndexName: 'GSI1',
            KeySchema: [
              { AttributeName: 'GSI1PK', KeyType: 'HASH' },
              { AttributeName: 'GSI1SK', KeyType: 'RANGE' },
            ],
            Projection: { ProjectionType: 'ALL' },
          },
        ],
      }),
    });
  });

  it('creates three private, encrypted, SSL-only buckets; traces expire after 90 days', () => {
    data.resourceCountIs('AWS::S3::Bucket', 3);
    const buckets = data.findResources('AWS::S3::Bucket');
    for (const b of Object.values(buckets)) {
      expect(b.Properties.PublicAccessBlockConfiguration).toEqual({
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      });
      expect(
        b.Properties.BucketEncryption.ServerSideEncryptionConfiguration[0].ServerSideEncryptionByDefault,
      ).toEqual({
        SSEAlgorithm: 'AES256',
      });
      expect(b.DeletionPolicy).toBe('Retain');
    }
    data.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: { Rules: [Match.objectLike({ ExpirationInDays: 90, Status: 'Enabled' })] },
    });
    const policies = Object.values(data.findResources('AWS::S3::BucketPolicy'));
    expect(policies).toHaveLength(3);
    for (const p of policies) {
      expect(JSON.stringify(p.Properties.PolicyDocument)).toContain('"aws:SecureTransport":"false"');
    }
  });

  it('creates the secret placeholders ica/llm and ica/search without plaintext values', () => {
    data.hasResourceProperties('AWS::SecretsManager::Secret', { Name: 'ica/llm' });
    data.hasResourceProperties('AWS::SecretsManager::Secret', { Name: 'ica/search' });
    expect(JSON.stringify(data.toJSON())).not.toContain('dummy-provider-key-must-not-leak');
  });

  it('destroys data on deletion with -c ephemeral=true', () => {
    const t = Template.fromStack(build({ ephemeral: 'true' }).data);
    t.hasResource('AWS::DynamoDB::Table', { DeletionPolicy: 'Delete' });
    t.hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Delete' });
  });

  it('matches the snapshot', () => {
    expect(normalised(data)).toMatchSnapshot();
  });
});

describe('ApiStack', () => {
  it('runs the Run Lambda with 1769 MB, 15 min, arm64, Node 22 and no async retries', () => {
    api.hasResourceProperties('AWS::Lambda::Function', {
      Description: Match.stringLikeRegexp('^Run Lambda'),
      MemorySize: 1769,
      Timeout: 900,
      Architectures: ['arm64'],
      Runtime: 'nodejs22.x',
      Handler: 'index.handler',
    });
    api.hasResourceProperties('AWS::Lambda::EventInvokeConfig', { MaximumRetryAttempts: 0 });
  });

  it('sizes the other Lambdas as specified', () => {
    const fns = Object.values(api.findResources('AWS::Lambda::Function')).map((f) => f.Properties);
    const byDesc = (re: RegExp) => fns.find((p) => re.test(p.Description ?? ''));
    expect(byDesc(/^HTTP API router/)).toMatchObject({ MemorySize: 512, Timeout: 29 });
    expect(byDesc(/^Scenario Author/)).toMatchObject({ MemorySize: 1024, Timeout: 60 });
    for (const re of [/^WebSocket \$connect/, /^WebSocket \$disconnect/, /^DynamoDB stream/]) {
      expect(byDesc(re)?.MemorySize).toBe(256);
    }
    for (const p of fns.filter((f) => f.Runtime?.startsWith('nodejs') && f.Description)) {
      expect(p.Runtime).toBe('nodejs22.x');
    }
  });

  it('never puts secrets in Lambda environments and passes allow-listed settings', () => {
    const envs = Object.values(api.findResources('AWS::Lambda::Function')).map(
      (f) => f.Properties.Environment?.Variables ?? {},
    );
    for (const vars of envs) {
      for (const k of Object.keys(vars)) expect(k).not.toMatch(/API_KEY/);
    }
    expect(JSON.stringify(api.toJSON())).not.toContain('dummy-provider-key-must-not-leak');
    const apiEnv = envs.find((v) => v.RUN_FUNCTION_NAME);
    expect(apiEnv).toMatchObject({
      AUTH_MODE: 'cognito',
      MAX_RUNS_PER_DAY: '20',
      LLM_MODEL: 'claude-sonnet-5',
    });
    const runEnv = envs.find((v) => v.KNOWLEDGE_BUCKET && v.LLM_SECRET_ARN);
    expect(runEnv).toBeDefined();
    // Names the Run/author handlers read (lambdaSecretIds, knowledgeS3PathFromEnv) and the hybrid-retrieval backends.
    expect(runEnv).toMatchObject({
      KB_EMBEDDINGS: 'cohere',
      KB_VECTOR_STORE: 's3vectors',
      KB_EMBED_MODEL: 'eu.cohere.embed-v4:0',
      KB_EMBED_DIMS: '1536',
      KB_RERANK: 'on',
      KB_RERANK_MODEL: 'cohere.rerank-v3-5:0',
      KB_RERANK_REGION: 'eu-central-1',
    });
    expect(runEnv?.KB_VECTOR_BUCKET).toBeDefined();
    expect(runEnv?.KB_VECTOR_INDEX).toBeDefined();
    expect(runEnv?.SEARCH_SECRET_ARN).toBeDefined();
    // Both runtime Lambdas (Run + author) get the same knowledge env.
    expect(envs.filter((v) => v.KB_VECTOR_STORE === 's3vectors')).toHaveLength(2);
  });

  it('selects the knowledge backends by mode (hybrid default, bm25, local only with the node module)', () => {
    const vec = { bucket: 'b', index: 'i', region: 'eu-west-2', rerankRegion: 'eu-central-1' };
    expect(runtimeEmbeddingEnv('hybrid', [], vec)).toMatchObject({
      KB_EMBEDDINGS: 'cohere',
      KB_VECTOR_STORE: 's3vectors',
      KB_VECTOR_BUCKET: 'b',
      KB_VECTOR_INDEX: 'i',
      KB_EMBED_REGION: 'eu-west-2',
    });
    expect(runtimeEmbeddingEnv('bm25', [], vec)).toEqual({
      KB_EMBEDDINGS: 'none',
      KB_VECTOR_STORE: 'none',
      KB_RERANK: 'off',
    });
    expect(runtimeEmbeddingEnv('local', [], vec)).toMatchObject({ KB_EMBEDDINGS: 'none' });
    expect(runtimeEmbeddingEnv('local', [LOCAL_EMBEDDER_PKG], vec)).toMatchObject({
      KB_EMBEDDINGS: 'local',
      KB_MODEL_CACHE: '/tmp/hf',
    });
  });

  it('grants the knowledge Lambdas exactly the Cohere embed/rerank models and QueryVectors on the index', () => {
    const policies = Object.values(api.findResources('AWS::IAM::Policy'));
    const statements = policies.flatMap(
      (p) => p.Properties.PolicyDocument.Statement as { Sid?: string; Action: unknown; Resource: unknown }[],
    );
    const embed = statements.filter((st) => st.Sid === 'KnowledgeEmbedAndRerank');
    expect(embed).toHaveLength(2); // Run + author
    const res = JSON.stringify(embed[0].Resource);
    expect(embed[0].Action).toBe('bedrock:InvokeModel');
    expect(res).toContain('inference-profile/eu.cohere.embed-v4:0');
    for (const r of [
      'eu-north-1',
      'eu-west-3',
      'eu-south-1',
      'eu-west-2',
      'eu-south-2',
      'eu-west-1',
      'eu-central-1',
    ])
      expect(res).toContain(`:bedrock:${r}::foundation-model/cohere.embed-v4:0`);
    expect(res).toContain(':bedrock:eu-central-1::foundation-model/cohere.rerank-v3-5:0');
    expect(res).not.toContain('*');
    const vq = statements.filter((st) => st.Sid === 'KnowledgeVectorQuery');
    expect(vq).toHaveLength(2);
    expect(vq[0].Action).toEqual(['s3vectors:GetVectors', 's3vectors:QueryVectors']);
    expect(JSON.stringify(vq[0].Resource)).toContain('KnowledgeVectorIndexIndexArn');
    // -c knowledge=bm25: no Bedrock or S3 Vectors grants at all.
    const bm25 = JSON.stringify(Template.fromStack(build({ knowledge: 'bm25' }).api).toJSON());
    expect(bm25).not.toContain('KnowledgeEmbedAndRerank');
    expect(bm25).not.toContain('s3vectors:QueryVectors');
    expect(bm25).toContain('"KB_EMBEDDINGS":"none"');
  });

  it('filters the stream to EVT# inserts with batch 100 and partial batch failures', () => {
    api.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      BatchSize: 100,
      StartingPosition: 'LATEST',
      FunctionResponseTypes: ['ReportBatchItemFailures'],
      FilterCriteria: {
        Filters: [
          {
            Pattern: JSON.stringify({
              eventName: ['INSERT'],
              dynamodb: { Keys: { SK: { S: [{ prefix: 'EVT#' }] } } },
            }),
          },
        ],
      },
    });
  });

  it('configures a public PKCE app client (code grant, no secret) and an admin-only pool with optional TOTP MFA', () => {
    api.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      GenerateSecret: false,
      AllowedOAuthFlows: ['code'],
      AllowedOAuthFlowsUserPoolClient: true,
      AllowedOAuthScopes: ['openid', 'email', 'profile'],
      CallbackURLs: Match.arrayWith(['http://localhost:5173']),
    });
    api.hasResourceProperties('AWS::Cognito::UserPool', {
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
      MfaConfiguration: 'OPTIONAL',
      EnabledMfas: ['SOFTWARE_TOKEN_MFA'],
      UsernameAttributes: ['email'],
      Policies: { PasswordPolicy: Match.objectLike({ MinimumLength: 14, RequireSymbols: true }) },
    });
    api.hasResourceProperties('AWS::Cognito::UserPoolDomain', { Domain: 'ica-test-prefix' });
  });

  it('puts the JWT authorizer on every HTTP route and throttles the stage (20 rps, burst 40)', () => {
    const routes = Object.values(api.findResources('AWS::ApiGatewayV2::Route')).map((r) => r.Properties);
    const httpRoutes = routes.filter((r) => !String(r.RouteKey).startsWith('$'));
    expect(httpRoutes.map((r) => r.RouteKey).sort()).toEqual(
      Object.values(API_ROUTES)
        .map((r) => `${r.method} ${r.path}`)
        .sort(),
    );
    for (const r of httpRoutes) expect(r.AuthorizationType).toBe('JWT');
    api.hasResourceProperties('AWS::ApiGatewayV2::Authorizer', { AuthorizerType: 'JWT' });
    api.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
      StageName: '$default',
      DefaultRouteSettings: { ThrottlingRateLimit: 20, ThrottlingBurstLimit: 40 },
      AccessLogSettings: Match.anyValue(),
    });
    expect(
      routes
        .filter((r) => String(r.RouteKey).startsWith('$'))
        .map((r) => r.RouteKey)
        .sort(),
    ).toEqual(['$connect', '$default', '$disconnect']);
  });

  it('adds the opt-in regional WAF on the Cognito pool (rate 100 / 5 min / IP + common rules)', () => {
    api.resourceCountIs('AWS::WAFv2::WebACL', 0);
    const withWaf = Template.fromStack(build({ regionalWaf: 'true' }).api);
    withWaf.hasResourceProperties('AWS::WAFv2::WebACL', {
      Scope: 'REGIONAL',
      Rules: Match.arrayWith([
        Match.objectLike({
          Statement: { RateBasedStatement: { Limit: 100, AggregateKeyType: 'IP', EvaluationWindowSec: 300 } },
          Action: { Block: {} },
        }),
        Match.objectLike({ Name: 'AWSManagedRulesCommonRuleSet' }),
      ]),
    });
    withWaf.resourceCountIs('AWS::WAFv2::WebACLAssociation', 1);
  });

  it('has a USD 20 monthly budget with 80% and 100% email notifications', () => {
    api.hasResourceProperties('AWS::Budgets::Budget', {
      Budget: { BudgetType: 'COST', TimeUnit: 'MONTHLY', BudgetLimit: { Amount: 20, Unit: 'USD' } },
      NotificationsWithSubscribers: [
        Match.objectLike({
          Notification: Match.objectLike({ Threshold: 80 }),
          Subscribers: [{ SubscriptionType: 'EMAIL', Address: 'ops@example.com' }],
        }),
        Match.objectLike({ Notification: Match.objectLike({ Threshold: 100 }) }),
      ],
    });
  });

  it('alarms on run errors, throttles, p95 duration, fan-out iterator age and API 5xx to an SNS email topic', () => {
    api.resourceCountIs('AWS::CloudWatch::Alarm', 5);
    api.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'Duration',
      ExtendedStatistic: 'p95',
      Threshold: 720000,
    });
    api.hasResourceProperties('AWS::CloudWatch::Alarm', { MetricName: 'IteratorAge', Threshold: 60000 });
    api.hasResourceProperties('AWS::CloudWatch::Alarm', { MetricName: '5xx', Threshold: 5 });
    api.hasResourceProperties('AWS::SNS::Subscription', { Protocol: 'email', Endpoint: 'ops@example.com' });
  });

  it('grants least privilege: WS connect only writes WS# rows, LLM bedrock wildcards only when configured', () => {
    const policies = JSON.stringify(api.findResources('AWS::IAM::Policy'));
    expect(policies).toContain('"dynamodb:LeadingKeys":["WS#*"]');
    // Only the knowledge statement (specific model ARNs) by default; the LLM wildcard grant needs LLM_PROVIDER=bedrock.
    expect(policies).not.toContain('foundation-model/*');
    expect(policies).not.toContain('bedrock:InvokeModelWithResponseStream');
    const bedrock = Template.fromStack(
      build({}, { ...DUMMY_ENV, LLM_FALLBACK_PROVIDER: 'bedrock', LLM_FALLBACK_MODEL: 'x' }).api,
    );
    expect(JSON.stringify(bedrock.findResources('AWS::IAM::Policy'))).toContain('foundation-model/*');
  });

  it('lets only the api Lambda read users of its own pool (AdminGetUser, approver display names)', () => {
    const withGetUser = Object.entries(api.findResources('AWS::IAM::Policy')).filter(([, p]) =>
      JSON.stringify(p).includes('cognito-idp:AdminGetUser'),
    );
    expect(withGetUser).toHaveLength(1);
    const statements = (
      withGetUser[0]![1] as { Properties: { PolicyDocument: { Statement: Record<string, unknown>[] } } }
    ).Properties.PolicyDocument.Statement.filter((s) => s.Action === 'cognito-idp:AdminGetUser');
    expect(statements).toHaveLength(1);
    expect(JSON.stringify(statements[0]!.Resource)).toContain('UserPool');
    expect(JSON.stringify(statements[0]!.Resource)).not.toContain('*');
    const apiFn = Object.values(api.findResources('AWS::Lambda::Function')).find(
      (f) => (f as { Properties: { Description?: string } }).Properties.Description === 'HTTP API router',
    ) as { Properties: { Environment: { Variables: Record<string, unknown> } } };
    expect(apiFn.Properties.Environment.Variables.USER_POOL_ID).toBeDefined();
  });

  it('deploys config.json (WebRuntimeConfig, cognito mode) and outputs what the scripts need', () => {
    api.resourceCountIs('Custom::CDKBucketDeployment', 1);
    const outputs = Object.keys(api.toJSON().Outputs ?? {});
    for (const o of ['HttpApiUrl', 'WsApiUrl', 'UserPoolId', 'UserPoolClientId', 'CognitoDomain', 'Region']) {
      expect(outputs).toContain(o);
    }
  });

  it('matches the snapshot', () => {
    expect(normalised(api)).toMatchSnapshot();
  });
});

describe('WebStack and WebWafStack', () => {
  it('serves the SPA through CloudFront + OAC with SPA fallback and the us-east-1 WebACL', () => {
    web.resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);
    web.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        DefaultRootObject: 'index.html',
        WebACLId: Match.anyValue(),
        CustomErrorResponses: [
          { ErrorCode: 403, ResponseCode: 200, ResponsePagePath: '/index.html', ErrorCachingMinTTL: 0 },
          { ErrorCode: 404, ResponseCode: 200, ResponsePagePath: '/index.html', ErrorCachingMinTTL: 0 },
        ],
        DefaultCacheBehavior: Match.objectLike({ ViewerProtocolPolicy: 'redirect-to-https' }),
      }),
    });
  });

  it('sends a strict CSP, HSTS, nosniff, referrer and permissions policies', () => {
    const cfg = Object.values(web.findResources('AWS::CloudFront::ResponseHeadersPolicy'))[0].Properties
      .ResponseHeadersPolicyConfig;
    const csp = JSON.stringify(cfg.SecurityHeadersConfig.ContentSecurityPolicy);
    for (const d of [
      "default-src 'self'",
      "img-src 'self' data:",
      "frame-ancestors 'none'",
      'connect-src',
      'amazoncognito.com',
    ]) {
      expect(csp).toContain(d);
    }
    expect(cfg.SecurityHeadersConfig.StrictTransportSecurity).toMatchObject({
      IncludeSubdomains: true,
      Override: true,
    });
    expect(cfg.SecurityHeadersConfig.ContentTypeOptions).toEqual({ Override: true });
    expect(cfg.SecurityHeadersConfig.ReferrerPolicy.ReferrerPolicy).toBe('strict-origin-when-cross-origin');
    expect(cfg.CustomHeadersConfig.Items[0].Header).toBe('Permissions-Policy');
  });

  it('defines the CloudFront WebACL in us-east-1 with the rate rule and managed common rules', () => {
    expect(built.webWaf?.region).toBe('us-east-1');
    waf.hasResourceProperties('AWS::WAFv2::WebACL', {
      Scope: 'CLOUDFRONT',
      DefaultAction: { Allow: {} },
      Rules: Match.arrayWith([
        Match.objectLike({
          Name: 'RateLimitPerIp',
          Statement: { RateBasedStatement: { Limit: 100, AggregateKeyType: 'IP', EvaluationWindowSec: 300 } },
        }),
        Match.objectLike({
          Statement: {
            ManagedRuleGroupStatement: { VendorName: 'AWS', Name: 'AWSManagedRulesCommonRuleSet' },
          },
        }),
      ]),
    });
  });

  it('matches the snapshots', () => {
    expect(normalised(web)).toMatchSnapshot();
    expect(normalised(waf)).toMatchSnapshot();
  });
});

describe('cdk-nag', () => {
  const findings = (b: BuiltApp) =>
    new IcaNagChecks(undefined, { verbose: false }, extraNagSuppressions(b.config))
      .validateScope(b.app)
      .violations.map(
        (v) =>
          `${v.ruleName} @ ${v.violatingResources.map((r) => (r as { constructPath?: string }).constructPath).join(', ')}`,
      );

  it('reports no unsuppressed AwsSolutions findings (default and opt-in/opt-out variants)', () => {
    expect(findings(build())).toEqual([]);
    expect(findings(build({ regionalWaf: 'true', ephemeral: 'true' }))).toEqual([]);
    const noCfWaf = build({ cloudfrontWaf: 'false' });
    expect(noCfWaf.webWaf).toBeUndefined();
    expect(findings(noCfWaf)).toEqual([]);
  }, 60_000);

  it('flags a distribution without WAF unless the opt-out is explicit', () => {
    const noCfWaf = build({ cloudfrontWaf: 'false' });
    const strict = new IcaNagChecks(undefined, { verbose: false }).validateScope(noCfWaf.app);
    expect(strict.violations.map((v) => v.ruleName)).toContain('AwsSolutions-CFR2');
  }, 60_000);
});

describe('lean defaults (near-zero idle cost)', () => {
  it('has no WAF, alarms, budget, search secret, PITR or reserved concurrency unless opted in', () => {
    const lean = build({}, { ...DUMMY_ENV, FEATURE_WEB_SEARCH: 'false' });
    expect(lean.webWaf).toBeUndefined();
    const leanApi = Template.fromStack(lean.api);
    const leanData = Template.fromStack(lean.data);
    leanApi.resourceCountIs('AWS::CloudWatch::Alarm', 0);
    leanApi.resourceCountIs('AWS::Budgets::Budget', 0);
    leanApi.resourceCountIs('AWS::SNS::Topic', 0);
    leanData.resourceCountIs('AWS::SecretsManager::Secret', 1);
    leanData.hasResourceProperties('AWS::DynamoDB::Table', {
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: false },
    });
    for (const fn of Object.values(leanApi.findResources('AWS::Lambda::Function'))) {
      expect(
        (fn as { Properties: Record<string, unknown> }).Properties.ReservedConcurrentExecutions,
      ).toBeUndefined();
    }
  });
});
