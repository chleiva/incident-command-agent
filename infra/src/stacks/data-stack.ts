/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * DataStack (spec §12): the single DynamoDB table (stream NEW_IMAGE, TTL, PITR, GSI1 projection ALL — the exact
 * layout `DynamoStore` uses), private S3 buckets (site, knowledge, traces), the Amazon S3 Vectors bucket + index for
 * the knowledge embeddings (Cohere Embed v4, 1536 dims, cosine) and the Secrets Manager placeholders.
 * RETAIN by default; `-c ephemeral=true` destroys everything on stack deletion.
 */
import { CfnOutput, Duration, Fn, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { AttributeType, BillingMode, StreamViewType, Table, ProjectionType } from 'aws-cdk-lib/aws-dynamodb';
import { PolicyStatement, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import {
  BlockPublicAccess,
  Bucket,
  BucketEncryption,
  HttpMethods,
  ObjectOwnership,
  type BucketProps,
} from 'aws-cdk-lib/aws-s3';
import { CfnIndex, CfnVectorBucket } from 'aws-cdk-lib/aws-s3vectors';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import type { Construct } from 'constructs';

export interface DataStackProps extends StackProps {
  ephemeral: boolean;
  /** Create the optional `ica/search` secret (only when FEATURE_WEB_SEARCH=true). */
  webSearch?: boolean;
}

export const LLM_SECRET_NAME = 'ica/llm';
/** Knowledge embedding dimension (Cohere Embed v4 `output_dimension`); must match `kb:build` (manifest). */
export const KB_VECTOR_DIMS = 1536;
/** Non-filterable metadata keys on the vector index (the content hash kb:upload uses for idempotent syncs). */
export const KB_VECTOR_NON_FILTERABLE_KEYS = ['hash'];
export const SEARCH_SECRET_NAME = 'ica/search';

export class DataStack extends Stack {
  readonly table: Table;
  readonly siteBucket: Bucket;
  readonly knowledgeBucket: Bucket;
  readonly tracesBucket: Bucket;
  readonly llmSecret: Secret;
  readonly searchSecret?: Secret;
  readonly vectorBucket: CfnVectorBucket;
  readonly vectorIndex: CfnIndex;
  /** Names parsed from the ARNs (CloudFormation generates them; no replacement conflicts). */
  readonly vectorBucketName: string;
  readonly vectorIndexName: string;
  readonly vectorIndexArn: string;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);
    const removalPolicy = props.ephemeral ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN;

    this.table = new Table(this, 'Table', {
      partitionKey: { name: 'PK', type: AttributeType.STRING },
      sortKey: { name: 'SK', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      stream: StreamViewType.NEW_IMAGE,
      timeToLiveAttribute: 'ttl',
      // PITR off: run data is ephemeral and PITR bills per GB-month (owner wants ~zero idle cost).
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: false },
      removalPolicy,
    });
    // Connections by run AND runs / scenarios / eval reports listing (see packages/store/src/keys.ts).
    this.table.addGlobalSecondaryIndex({
      indexName: 'GSI1',
      partitionKey: { name: 'GSI1PK', type: AttributeType.STRING },
      sortKey: { name: 'GSI1SK', type: AttributeType.STRING },
      projectionType: ProjectionType.ALL,
    });

    const bucketDefaults: BucketProps = {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      objectOwnership: ObjectOwnership.BUCKET_OWNER_ENFORCED,
      removalPolicy,
      autoDeleteObjects: props.ephemeral,
    };
    this.siteBucket = new Bucket(this, 'SiteBucket', bucketDefaults);
    this.knowledgeBucket = new Bucket(this, 'KnowledgeBucket', { ...bucketDefaults, versioned: false });
    this.tracesBucket = new Bucket(this, 'TracesBucket', {
      ...bucketDefaults,
      lifecycleRules: [{ id: 'expire-traces', expiration: Duration.days(90) }],
      // Presigned export downloads (GET only; URLs are short-lived and unguessable).
      cors: [{ allowedMethods: [HttpMethods.GET], allowedOrigins: ['*'], maxAge: 3600 }],
    });

    // Knowledge vectors (S3 Vectors, CDK L1). Storage-priced only (≈ USD 0.06/GB-month: ~0.1 GB for ~19k vectors),
    // no idle compute. Vector key = chunkId; filterable metadata: collection, jurisdiction, sourceId, docId (+ MEL
    // itemNumber/ataChapter, precedent phase/aircraftType); the text stays in the knowledge bucket's chunk files.
    this.vectorBucket = new CfnVectorBucket(this, 'KnowledgeVectorBucket', {
      encryptionConfiguration: { sseType: 'AES256' },
    });
    this.vectorBucket.applyRemovalPolicy(removalPolicy);
    this.vectorIndex = new CfnIndex(this, 'KnowledgeVectorIndex', {
      vectorBucketArn: this.vectorBucket.attrVectorBucketArn,
      dataType: 'float32',
      dimension: KB_VECTOR_DIMS,
      distanceMetric: 'cosine',
      metadataConfiguration: { nonFilterableMetadataKeys: KB_VECTOR_NON_FILTERABLE_KEYS },
    });
    this.vectorIndex.applyRemovalPolicy(removalPolicy);
    // arn:aws:s3vectors:<region>:<account>:bucket/<bucket>/index/<index>
    this.vectorIndexArn = this.vectorIndex.attrIndexArn;
    this.vectorBucketName = Fn.select(1, Fn.split('/', this.vectorBucket.attrVectorBucketArn));
    this.vectorIndexName = Fn.select(3, Fn.split('/', this.vectorIndex.attrIndexArn));

    // CloudFront (WebStack) reads the site through Origin Access Control. The distribution lives in another stack,
    // so the grant is scoped to this account's distributions to avoid a cross-stack dependency cycle.
    this.siteBucket.addToResourcePolicy(
      new PolicyStatement({
        sid: 'AllowCloudFrontOAC',
        actions: ['s3:GetObject'],
        resources: [this.siteBucket.arnForObjects('*')],
        principals: [new ServicePrincipal('cloudfront.amazonaws.com')],
        conditions: {
          StringEquals: { 'AWS:SourceAccount': this.account },
          ArnLike: { 'AWS:SourceArn': `arn:${this.partition}:cloudfront::${this.account}:distribution/*` },
        },
      }),
    );

    // Placeholders: real values are written by `npm run secrets:set` and never pass through CloudFormation.
    this.llmSecret = new Secret(this, 'LlmSecret', {
      secretName: LLM_SECRET_NAME,
      description:
        'LLM provider keys as JSON {ANTHROPIC_API_KEY, OPENAI_API_KEY}. Set with npm run secrets:set.',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '' }),
        generateStringKey: '_placeholder',
        excludePunctuation: true,
      },
      removalPolicy: RemovalPolicy.DESTROY,
    });
    if (props.webSearch)
      this.searchSecret = new Secret(this, 'SearchSecret', {
        secretName: SEARCH_SECRET_NAME,
        description: 'Optional web-search keys as JSON {TAVILY_API_KEY, BRAVE_API_KEY}.',
        generateSecretString: {
          secretStringTemplate: JSON.stringify({ TAVILY_API_KEY: '', BRAVE_API_KEY: '' }),
          generateStringKey: '_placeholder',
          excludePunctuation: true,
        },
        removalPolicy: RemovalPolicy.DESTROY,
      });

    const out = (id: string, value: string) => new CfnOutput(this, id, { value });
    out('TableName', this.table.tableName);
    out('TableArn', this.table.tableArn);
    out('TableStreamArn', this.table.tableStreamArn!);
    out('SiteBucketName', this.siteBucket.bucketName);
    out('KnowledgeBucketName', this.knowledgeBucket.bucketName);
    out('TracesBucketName', this.tracesBucket.bucketName);
    out('LlmSecretArn', this.llmSecret.secretArn);
    out('VectorBucketName', this.vectorBucketName);
    out('VectorIndexName', this.vectorIndexName);
    out('VectorIndexArn', this.vectorIndexArn);
    if (this.searchSecret) out('SearchSecretArn', this.searchSecret.secretArn);
  }
}
