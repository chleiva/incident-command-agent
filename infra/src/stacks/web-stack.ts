/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * WebStack (spec §12): CloudFront + Origin Access Control over the private site bucket, SPA fallback, strict
 * security headers, the us-east-1 WebACL and the deployment of `apps/web/dist`.
 *
 * `config.json` (WebRuntimeConfig) is deployed by ApiStack, not here: Cognito's callback URLs need this
 * distribution's domain, so ApiStack depends on WebStack and owns everything derived from the API outputs.
 * For the same reason the CSP names API Gateway and Cognito by their regional host patterns.
 */
import { CfnOutput, Duration, Stack, type StackProps } from 'aws-cdk-lib';
import {
  AllowedMethods,
  CachePolicy,
  Distribution,
  HeadersFrameOption,
  HeadersReferrerPolicy,
  HttpVersion,
  PriceClass,
  ResponseHeadersPolicy,
  ViewerProtocolPolicy,
} from 'aws-cdk-lib/aws-cloudfront';
import { S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { Bucket, type IBucket } from 'aws-cdk-lib/aws-s3';
import { BucketDeployment, CacheControl, Source } from 'aws-cdk-lib/aws-s3-deployment';
import type { Construct } from 'constructs';

export interface WebStackProps extends StackProps {
  siteBucket: IBucket;
  webAclArn?: string;
  cognitoDomainPrefix: string;
  webDistDir: string;
}

export function contentSecurityPolicy(region: string, cognitoDomainPrefix: string): string {
  const connect = [
    "'self'",
    `https://*.execute-api.${region}.amazonaws.com`,
    `wss://*.execute-api.${region}.amazonaws.com`,
    `https://${cognitoDomainPrefix}.auth.${region}.amazoncognito.com`,
    `https://cognito-idp.${region}.amazonaws.com`,
    // Presigned export downloads from the traces bucket.
    `https://*.s3.${region}.amazonaws.com`,
  ];
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    `connect-src ${connect.join(' ')}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export class WebStack extends Stack {
  readonly distribution: Distribution;
  readonly siteUrl: string;

  constructor(scope: Construct, id: string, props: WebStackProps) {
    super(scope, id, props);
    // Imported by attributes so the OAC bucket policy stays in DataStack (no cross-stack cycle).
    const site = Bucket.fromBucketAttributes(this, 'SiteBucket', {
      bucketArn: props.siteBucket.bucketArn,
      bucketName: props.siteBucket.bucketName,
      bucketRegionalDomainName: props.siteBucket.bucketRegionalDomainName,
    });

    const headers = new ResponseHeadersPolicy(this, 'SecurityHeaders', {
      comment: 'Incident Coordination Agent: strict security headers',
      securityHeadersBehavior: {
        contentSecurityPolicy: {
          contentSecurityPolicy: contentSecurityPolicy(this.region, props.cognitoDomainPrefix),
          override: true,
        },
        strictTransportSecurity: {
          accessControlMaxAge: Duration.days(730),
          includeSubdomains: true,
          preload: true,
          override: true,
        },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: HeadersFrameOption.DENY, override: true },
        referrerPolicy: {
          referrerPolicy: HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
          override: true,
        },
        xssProtection: { protection: true, modeBlock: true, override: true },
      },
      customHeadersBehavior: {
        customHeaders: [
          {
            header: 'Permissions-Policy',
            // microphone=(self): the report dialog's optional dictation (browser speech recognition, same origin only).
            value: 'camera=(), microphone=(self), geolocation=(), payment=(), usb=()',
            override: true,
          },
        ],
      },
    });

    const origin = S3BucketOrigin.withOriginAccessControl(site);
    this.distribution = new Distribution(this, 'Distribution', {
      comment: 'Incident Coordination Agent cockpit',
      defaultRootObject: 'index.html',
      httpVersion: HttpVersion.HTTP2_AND_3,
      priceClass: PriceClass.PRICE_CLASS_100,
      webAclId: props.webAclArn,
      defaultBehavior: {
        origin,
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachePolicy: CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: headers,
        compress: true,
      },
      additionalBehaviors: {
        '/config.json': {
          origin,
          viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: CachePolicy.CACHING_DISABLED,
          responseHeadersPolicy: headers,
        },
      },
      // SPA fallback: deep links resolve to index.html.
      errorResponses: [403, 404].map((httpStatus) => ({
        httpStatus,
        responseHttpStatus: 200,
        responsePagePath: '/index.html',
        ttl: Duration.seconds(0),
      })),
    });
    this.siteUrl = `https://${this.distribution.distributionDomainName}`;

    // Hashed assets: long cache. index.html: no-cache. config.json is owned by ApiStack (excluded from pruning).
    const assets = new BucketDeployment(this, 'DeployAssets', {
      sources: [Source.asset(props.webDistDir)],
      destinationBucket: site,
      exclude: ['index.html', 'config.json'],
      cacheControl: [CacheControl.fromString('public, max-age=31536000, immutable')],
      prune: true,
      memoryLimit: 512,
    });
    const index = new BucketDeployment(this, 'DeployIndex', {
      sources: [Source.asset(props.webDistDir)],
      destinationBucket: site,
      exclude: ['*'],
      include: ['index.html'],
      cacheControl: [CacheControl.noCache()],
      prune: false,
      distribution: this.distribution,
      distributionPaths: ['/*'],
      memoryLimit: 512,
    });
    index.node.addDependency(assets);

    new CfnOutput(this, 'SiteUrl', { value: this.siteUrl });
    new CfnOutput(this, 'DistributionId', { value: this.distribution.distributionId });
  }
}
