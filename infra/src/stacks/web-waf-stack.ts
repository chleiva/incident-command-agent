/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** WebWafStack: the CloudFront WebACL. CloudFront-scoped WAF must live in us-east-1 (cross-region reference). */
import { CfnOutput, Stack, type StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { createWebAcl } from '../waf';

export class WebWafStack extends Stack {
  readonly webAclArn: string;

  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);
    if (props.env?.region && props.env.region !== 'us-east-1' && !props.env.region.startsWith('${')) {
      throw new Error('WebWafStack must be deployed to us-east-1 (CloudFront WAF requirement)');
    }
    const acl = createWebAcl(this, 'CloudFrontWebAcl', 'CLOUDFRONT', 'ica-cloudfront');
    this.webAclArn = acl.attrArn;
    new CfnOutput(this, 'CloudFrontWebAclArn', { value: acl.attrArn });
  }
}
