/*
 * Copyright 2026 Ground Incident Coordination Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * ApiStack (spec §5, §11, §12): Cognito (PKCE public client), the HTTP API (JWT authorizer on every route,
 * throttled), the WebSocket API ($connect JWT check), the Lambdas with least-privilege roles, the stream fan-out,
 * the WAF on the Cognito user pool, the monthly budget, alarms and the SPA's `config.json`.
 */
import { API_ROUTES, type WebRuntimeConfig } from '@ica/schema';
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { AccessLogFormat } from 'aws-cdk-lib/aws-apigateway';
import {
  CorsHttpMethod,
  HttpApi,
  HttpMethod,
  HttpStage,
  LogGroupLogDestination,
  WebSocketApi,
  WebSocketStage,
} from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpJwtAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration, WebSocketLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { CfnBudget } from 'aws-cdk-lib/aws-budgets';
import { Alarm, ComparisonOperator, TreatMissingData, type IMetric } from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import type { IDistribution } from 'aws-cdk-lib/aws-cloudfront';
import {
  AccountRecovery,
  Mfa,
  OAuthScope,
  UserPool,
  UserPoolClientIdentityProvider,
} from 'aws-cdk-lib/aws-cognito';
import type { ITable } from 'aws-cdk-lib/aws-dynamodb';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { FilterCriteria, FilterRule, StartingPosition } from 'aws-cdk-lib/aws-lambda';
import { DynamoEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Bucket, type IBucket } from 'aws-cdk-lib/aws-s3';
import { BucketDeployment, CacheControl, Source } from 'aws-cdk-lib/aws-s3-deployment';
import type { ISecret } from 'aws-cdk-lib/aws-secretsmanager';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { EmailSubscription } from 'aws-cdk-lib/aws-sns-subscriptions';
import { CfnWebACLAssociation } from 'aws-cdk-lib/aws-wafv2';
import type { Construct } from 'constructs';
import type { InfraConfig } from '../config';
import { IcaFunction } from '../lambda';
import { createWebAcl } from '../waf';

export const LOCAL_DEV_ORIGIN = 'http://localhost:5173';
export const MONTHLY_BUDGET_USD = 20;
export const HTTP_RATE_LIMIT = 20;
export const HTTP_BURST_LIMIT = 40;

/** The local (transformers.js) query embedder and its native/optional dependencies. */
export const LOCAL_EMBEDDER_PKG = '@huggingface/transformers';
export const LOCAL_EMBEDDER_EXTERNALS = [LOCAL_EMBEDDER_PKG, 'onnxruntime-node', 'onnxruntime-web', 'sharp'];

/**
 * Retrieval mode for the Run/author Lambdas. Unless the local embedder is installed as a node module
 * (`-c runNodeModules=@huggingface/transformers`, with the model files at `KB_MODEL_CACHE`), a `local`-embedded
 * index is searched BM25-only in Lambda (`KB_EMBEDDINGS=none`); `openai`/`bedrock` query embedders are kept.
 */
export function runtimeEmbeddingEnv(
  lambdaEnv: Record<string, string>,
  runNodeModules: string[],
): Record<string, string> {
  const kb = (lambdaEnv.KB_EMBEDDINGS ?? 'local').toLowerCase();
  if (kb !== 'local') return { KB_EMBEDDINGS: kb };
  if (runNodeModules.includes(LOCAL_EMBEDDER_PKG))
    return { KB_EMBEDDINGS: 'local', HF_HOME: '/tmp/hf', KB_MODEL_CACHE: '/tmp/hf' };
  return { KB_EMBEDDINGS: 'none' };
}

export interface ApiStackProps extends StackProps {
  config: InfraConfig;
  table: ITable;
  tracesBucket: IBucket;
  knowledgeBucket: IBucket;
  siteBucket: IBucket;
  llmSecret: ISecret;
  searchSecret?: ISecret;
  distribution: IDistribution;
}

export class ApiStack extends Stack {
  readonly httpApi: HttpApi;
  readonly wsStage: WebSocketStage;
  readonly runFn: IcaFunction;
  readonly userPool: UserPool;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);
    const { config, table, tracesBucket, knowledgeBucket } = props;
    const removalPolicy = config.ephemeral ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN;
    const siteUrl = `https://${props.distribution.distributionDomainName}`;
    const cognitoDomain = `${config.cognitoDomainPrefix}.auth.${this.region}.amazoncognito.com`;

    // ------------------------------------------------------------------ Cognito (single user, admin-created)
    this.userPool = new UserPool(this, 'UserPool', {
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      autoVerify: { email: true },
      mfa: Mfa.OPTIONAL,
      mfaSecondFactor: { otp: true, sms: false },
      passwordPolicy: {
        minLength: 14,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
        tempPasswordValidity: Duration.days(3),
      },
      accountRecovery: AccountRecovery.EMAIL_ONLY,
      deletionProtection: !config.ephemeral,
      removalPolicy,
    });
    this.userPool.addDomain('HostedUiDomain', {
      cognitoDomain: { domainPrefix: config.cognitoDomainPrefix },
    });
    const callbackUrls = [siteUrl, `${siteUrl}/`, LOCAL_DEV_ORIGIN, `${LOCAL_DEV_ORIGIN}/`];
    const client = this.userPool.addClient('WebClient', {
      // Public SPA client: no secret, authorization code grant with PKCE.
      generateSecret: false,
      authFlows: { userSrp: true },
      oAuth: {
        flows: { authorizationCodeGrant: true, implicitCodeGrant: false, clientCredentials: false },
        scopes: [OAuthScope.OPENID, OAuthScope.EMAIL, OAuthScope.PROFILE],
        callbackUrls,
        logoutUrls: callbackUrls,
      },
      supportedIdentityProviders: [UserPoolClientIdentityProvider.COGNITO],
      preventUserExistenceErrors: true,
      enableTokenRevocation: true,
      accessTokenValidity: Duration.hours(1),
      idTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(30),
    });

    if (config.regionalWaf) {
      // WAF cannot attach to API Gateway HTTP or WebSocket APIs; the regional ACL protects the unauthenticated
      // surface instead (Cognito hosted UI / auth endpoints). See docs/deploy.md.
      const acl = createWebAcl(this, 'RegionalWebAcl', 'REGIONAL', 'ica-regional');
      new CfnWebACLAssociation(this, 'UserPoolWebAclAssociation', {
        resourceArn: this.userPool.userPoolArn,
        webAclArn: acl.attrArn,
      });
    }

    // ------------------------------------------------------------------ Lambdas
    const env = config.lambdaEnv;
    const common = {
      TABLE_NAME: table.tableName,
      TRACES_BUCKET: tracesBucket.bucketName,
    };
    const runtimeEnv = {
      ...env,
      ...common,
      KNOWLEDGE_BUCKET: knowledgeBucket.bucketName,
      LLM_SECRET_ARN: props.llmSecret.secretArn,
      ...(props.searchSecret ? { SEARCH_SECRET_ARN: props.searchSecret.secretArn } : {}),
      ...runtimeEmbeddingEnv(env, config.runNodeModules),
    };
    // The local embedder (transformers.js + onnxruntime-node native binding) cannot run from an esbuild bundle, so it
    // is left out unless explicitly installed with `-c runNodeModules=@huggingface/transformers` (docs/deploy.md).
    const runtimeExternals = config.runNodeModules.includes(LOCAL_EMBEDDER_PKG)
      ? []
      : LOCAL_EMBEDDER_EXTERNALS;
    const fn = (
      id: string,
      p: Omit<ConstructorParameters<typeof IcaFunction>[2], 'repoRoot' | 'removalPolicy'>,
    ) => new IcaFunction(this, id, { ...p, repoRoot: config.repoRoot, removalPolicy });

    this.runFn = fn('RunFn', {
      description: 'Run Lambda: world engine + agents for one scenario run',
      entry: 'services/run/handler.ts',
      handler: 'handler',
      memorySize: 1769,
      timeout: Duration.minutes(15),
      environment: runtimeEnv,
      nodeModules: config.runNodeModules,
      externalModules: runtimeExternals,
    });
    // A failed run must not be retried automatically (it would duplicate the run's events).
    this.runFn.configureAsyncInvoke({ retryAttempts: 0, maxEventAge: Duration.minutes(5) });

    const authorFn = fn('AuthorFn', {
      description: 'Scenario Author: free text → validated scenario',
      entry: 'services/api/src/lambda/author.ts',
      memorySize: 1024,
      timeout: Duration.seconds(60),
      environment: runtimeEnv,
      nodeModules: config.runNodeModules,
      externalModules: runtimeExternals,
    });

    const apiFn = fn('ApiFn', {
      description: 'HTTP API router',
      entry: 'services/api/src/lambda/http.ts',
      memorySize: 512,
      timeout: Duration.seconds(29),
      environment: {
        ...env,
        ...common,
        AUTH_MODE: 'cognito',
        // Approver display names: the SPA's access token has no email/name claim (AdminGetUser, see below).
        USER_POOL_ID: this.userPool.userPoolId,
        RUN_FUNCTION_NAME: this.runFn.functionName,
        AUTHOR_FUNCTION_NAME: authorFn.functionName,
        CORS_ORIGINS: [siteUrl, LOCAL_DEV_ORIGIN].join(','),
      },
      define: {
        'process.env.BRAND_PACK': JSON.stringify(config.brandPackJson),
        ...(config.stationsJson ? { 'process.env.STATIONS_JSON': JSON.stringify(config.stationsJson) } : {}),
      },
    });

    const wsEnv = {
      TABLE_NAME: table.tableName,
      USER_POOL_ID: this.userPool.userPoolId,
      USER_POOL_CLIENT_ID: client.userPoolClientId,
    };
    const wsConnectFn = fn('WsConnectFn', {
      description: 'WebSocket $connect: verifies the Cognito JWT, stores the connection',
      entry: 'services/api/src/lambda/ws.ts',
      handler: 'connect',
      memorySize: 256,
      timeout: Duration.seconds(10),
      environment: wsEnv,
    });
    const wsDisconnectFn = fn('WsDisconnectFn', {
      description: 'WebSocket $disconnect',
      entry: 'services/api/src/lambda/ws.ts',
      handler: 'disconnect',
      memorySize: 256,
      timeout: Duration.seconds(10),
      environment: wsEnv,
    });
    const wsDefaultFn = fn('WsDefaultFn', {
      description: 'WebSocket $default (ping)',
      entry: 'services/api/src/lambda/ws.ts',
      handler: 'defaultRoute',
      memorySize: 256,
      timeout: Duration.seconds(5),
    });

    // ------------------------------------------------------------------ IAM (least privilege per function)
    table.grantReadWriteData(apiFn);
    this.runFn.grantInvoke(apiFn);
    authorFn.grantInvoke(apiFn);
    // Explicit S3 actions (no grant-helper wildcards like s3:GetObject*).
    const s3 = (actions: string[], resources: string[]) => new PolicyStatement({ actions, resources });
    apiFn.addToRolePolicy(
      s3(['s3:GetObject', 's3:PutObject'], [tracesBucket.arnForObjects('traces/*/export.json')]),
    );
    // Resolve the approver's display name from the user pool (read-only, this pool only).
    apiFn.addToRolePolicy(
      new PolicyStatement({ actions: ['cognito-idp:AdminGetUser'], resources: [this.userPool.userPoolArn] }),
    );

    for (const f of [this.runFn, authorFn]) {
      props.llmSecret.grantRead(f);
      props.searchSecret?.grantRead(f);
      f.addToRolePolicy(s3(['s3:GetObject'], [knowledgeBucket.arnForObjects('*')]));
      f.addToRolePolicy(s3(['s3:ListBucket'], [knowledgeBucket.bucketArn]));
      f.addToRolePolicy(s3(['s3:GetObject', 's3:PutObject'], [tracesBucket.arnForObjects('traces/*')]));
      if (config.bedrock) {
        f.addToRolePolicy(
          new PolicyStatement({
            actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
            resources: [
              `arn:${this.partition}:bedrock:*::foundation-model/*`,
              `arn:${this.partition}:bedrock:*:${this.account}:inference-profile/*`,
            ],
          }),
        );
      }
    }
    table.grantReadWriteData(this.runFn);
    table.grantReadData(authorFn);

    const leading = (prefix: string) => ({
      'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': [`${prefix}*`] },
    });
    wsConnectFn.addToRolePolicy(
      new PolicyStatement({
        actions: ['dynamodb:GetItem'],
        resources: [table.tableArn],
        conditions: leading('RUN#'),
      }),
    );
    wsConnectFn.addToRolePolicy(
      new PolicyStatement({
        actions: ['dynamodb:PutItem'],
        resources: [table.tableArn],
        conditions: leading('WS#'),
      }),
    );
    const connectionCleanup = new PolicyStatement({
      actions: ['dynamodb:Query', 'dynamodb:DeleteItem'],
      resources: [table.tableArn],
      conditions: leading('WS#'),
    });
    wsDisconnectFn.addToRolePolicy(connectionCleanup);

    // ------------------------------------------------------------------ HTTP API (JWT on every route)
    const accessLogs = (id: string) =>
      new LogGroup(this, id, { retention: RetentionDays.ONE_MONTH, removalPolicy });
    this.httpApi = new HttpApi(this, 'HttpApi', {
      description: 'Ground Incident Coordination Agent HTTP API',
      createDefaultStage: false,
      corsPreflight: {
        allowOrigins: [siteUrl, LOCAL_DEV_ORIGIN],
        allowMethods: [CorsHttpMethod.GET, CorsHttpMethod.POST, CorsHttpMethod.OPTIONS],
        allowHeaders: ['authorization', 'content-type'],
        maxAge: Duration.hours(1),
      },
    });
    const stage = new HttpStage(this, 'HttpStage', {
      httpApi: this.httpApi,
      stageName: '$default',
      autoDeploy: true,
      throttle: { rateLimit: HTTP_RATE_LIMIT, burstLimit: HTTP_BURST_LIMIT },
      accessLogSettings: {
        destination: new LogGroupLogDestination(accessLogs('HttpAccessLogs')),
        format: AccessLogFormat.custom(
          JSON.stringify({
            requestId: '$context.requestId',
            ip: '$context.identity.sourceIp',
            requestTime: '$context.requestTime',
            method: '$context.httpMethod',
            routeKey: '$context.routeKey',
            status: '$context.status',
            latency: '$context.responseLatency',
            integrationError: '$context.integrationErrorMessage',
            authorizerError: '$context.authorizer.error',
          }),
        ),
      },
    });
    const authorizer = new HttpJwtAuthorizer(
      'CognitoJwt',
      `https://cognito-idp.${this.region}.amazonaws.com/${this.userPool.userPoolId}`,
      { jwtAudience: [client.userPoolClientId] },
    );
    const integration = new HttpLambdaIntegration('ApiIntegration', apiFn);
    for (const route of Object.values(API_ROUTES)) {
      this.httpApi.addRoutes({
        path: route.path,
        methods: [HttpMethod[route.method]],
        integration,
        authorizer,
      });
    }

    // ------------------------------------------------------------------ WebSocket API
    const wsApi = new WebSocketApi(this, 'WsApi', {
      description: 'Ground Incident Coordination Agent live events',
      connectRouteOptions: { integration: new WebSocketLambdaIntegration('WsConnect', wsConnectFn) },
      disconnectRouteOptions: { integration: new WebSocketLambdaIntegration('WsDisconnect', wsDisconnectFn) },
      defaultRouteOptions: {
        integration: new WebSocketLambdaIntegration('WsDefault', wsDefaultFn),
        returnResponse: true,
      },
    });
    this.wsStage = new WebSocketStage(this, 'WsStage', {
      webSocketApi: wsApi,
      stageName: 'prod',
      autoDeploy: true,
      throttle: { rateLimit: HTTP_RATE_LIMIT, burstLimit: HTTP_BURST_LIMIT },
    });

    // ------------------------------------------------------------------ stream fan-out
    const fanoutFn = fn('FanoutFn', {
      description: 'DynamoDB stream (EVT# rows) → WebSocket PostToConnection',
      entry: 'services/api/src/lambda/fanout.ts',
      memorySize: 256,
      timeout: Duration.seconds(30),
      environment: { ...common, WS_CALLBACK_URL: this.wsStage.callbackUrl },
    });
    fanoutFn.addEventSource(
      new DynamoEventSource(table, {
        startingPosition: StartingPosition.LATEST,
        batchSize: 100,
        // 0 s: the lowest latency (FR-02 first event < 2 s). Lambda's batching window is whole seconds only.
        maxBatchingWindow: Duration.seconds(0),
        reportBatchItemFailures: true,
        retryAttempts: 5,
        maxRecordAge: Duration.hours(1),
        filters: [
          FilterCriteria.filter({
            eventName: FilterRule.isEqual('INSERT'),
            dynamodb: { Keys: { SK: { S: FilterRule.beginsWith('EVT#') } } },
          }),
        ],
      }),
    );
    this.wsStage.grantManagementApiAccess(fanoutFn);
    fanoutFn.addToRolePolicy(s3(['s3:GetObject'], [tracesBucket.arnForObjects('traces/*')]));
    fanoutFn.addToRolePolicy(
      new PolicyStatement({ actions: ['dynamodb:Query'], resources: [`${table.tableArn}/index/GSI1`] }),
    );
    fanoutFn.addToRolePolicy(connectionCleanup);

    // ------------------------------------------------------------------ optional monitoring (-c monitoring=true)
    // Off by default: the owner wants ~zero idle cost and AWS spend is not a concern (alarms bill per alarm-month).
    if (config.monitoring) {
      new CfnBudget(this, 'MonthlyBudget', {
        budget: {
          budgetType: 'COST',
          timeUnit: 'MONTHLY',
          budgetLimit: { amount: MONTHLY_BUDGET_USD, unit: 'USD' },
        },
        notificationsWithSubscribers: [80, 100].map((threshold) => ({
          notification: {
            notificationType: 'ACTUAL',
            comparisonOperator: 'GREATER_THAN',
            threshold,
            thresholdType: 'PERCENTAGE',
          },
          subscribers: [{ subscriptionType: 'EMAIL', address: config.alertEmail }],
        })),
      });

      const topic = new Topic(this, 'AlarmTopic', {
        displayName: 'Ground Incident Coordination Agent alarms',
        enforceSSL: true,
      });
      topic.addSubscription(new EmailSubscription(config.alertEmail));
      const alarm = (
        id: string,
        metric: IMetric,
        threshold: number,
        op: ComparisonOperator,
        description: string,
      ) =>
        new Alarm(this, id, {
          metric,
          threshold,
          evaluationPeriods: 1,
          comparisonOperator: op,
          treatMissingData: TreatMissingData.NOT_BREACHING,
          alarmDescription: description,
        }).addAlarmAction(new SnsAction(topic));
      const GTE = ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD;
      const GT = ComparisonOperator.GREATER_THAN_THRESHOLD;
      const fiveMin = Duration.minutes(5);
      alarm(
        'RunErrors',
        this.runFn.metricErrors({ period: fiveMin, statistic: 'Sum' }),
        1,
        GTE,
        'Run Lambda errors',
      );
      alarm(
        'RunThrottles',
        this.runFn.metricThrottles({ period: fiveMin, statistic: 'Sum' }),
        1,
        GTE,
        'Run Lambda throttled',
      );
      alarm(
        'RunDurationP95',
        this.runFn.metricDuration({ period: fiveMin, statistic: 'p95' }),
        12 * 60_000,
        GT,
        'Run Lambda p95 duration > 12 min',
      );
      alarm(
        'FanoutIteratorAge',
        fanoutFn.metric('IteratorAge', { period: fiveMin, statistic: 'Maximum' }),
        60_000,
        GT,
        'Fan-out lagging > 60 s',
      );
      alarm(
        'Api5xx',
        this.httpApi.metricServerError({ period: fiveMin, statistic: 'Sum' }),
        5,
        GT,
        'HTTP API 5xx > 5 in 5 min',
      );
    }

    // ------------------------------------------------------------------ the SPA's runtime config
    const webConfig: WebRuntimeConfig = {
      apiUrl: this.httpApi.apiEndpoint,
      wsUrl: this.wsStage.url,
      auth: {
        mode: 'cognito',
        region: this.region,
        userPoolId: this.userPool.userPoolId,
        clientId: client.userPoolClientId,
        domain: cognitoDomain,
        redirectUri: `${siteUrl}/`,
      },
    };
    const site = Bucket.fromBucketAttributes(this, 'SiteBucket', {
      bucketArn: props.siteBucket.bucketArn,
      bucketName: props.siteBucket.bucketName,
    });
    new BucketDeployment(this, 'DeployWebConfig', {
      sources: [Source.jsonData('config.json', webConfig)],
      destinationBucket: site,
      prune: false,
      cacheControl: [CacheControl.noCache()],
      distribution: props.distribution,
      distributionPaths: ['/config.json'],
    });

    // ------------------------------------------------------------------ outputs (read by scripts/)
    const out = (id: string, value: string) => new CfnOutput(this, id, { value });
    out('HttpApiUrl', this.httpApi.apiEndpoint);
    out('WsApiUrl', this.wsStage.url);
    out('UserPoolId', this.userPool.userPoolId);
    out('UserPoolClientId', client.userPoolClientId);
    out('CognitoDomain', cognitoDomain);
    out('Region', this.region);
    out('RunFunctionName', this.runFn.functionName);
    out('HttpStageName', stage.stageName);
  }
}
