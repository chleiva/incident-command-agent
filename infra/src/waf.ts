/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** WAF WebACL (spec §11): AWS managed common rule set + known bad inputs + 100 requests / 5 min per IP. */
import { CfnWebACL } from 'aws-cdk-lib/aws-wafv2';
import type { Construct } from 'constructs';

export const RATE_LIMIT_PER_5_MIN = 100;

export function createWebAcl(
  scope: Construct,
  id: string,
  scopeName: 'CLOUDFRONT' | 'REGIONAL',
  name: string,
) {
  const visibility = (metricName: string) => ({
    cloudWatchMetricsEnabled: true,
    sampledRequestsEnabled: true,
    metricName,
  });
  const managed = (priority: number, ruleName: string) => ({
    name: ruleName,
    priority,
    overrideAction: { none: {} },
    statement: { managedRuleGroupStatement: { vendorName: 'AWS', name: ruleName } },
    visibilityConfig: visibility(`${name}-${ruleName}`),
  });
  return new CfnWebACL(scope, id, {
    scope: scopeName,
    defaultAction: { allow: {} },
    visibilityConfig: visibility(name),
    rules: [
      {
        name: 'RateLimitPerIp',
        priority: 0,
        action: { block: {} },
        statement: {
          rateBasedStatement: {
            limit: RATE_LIMIT_PER_5_MIN,
            evaluationWindowSec: 300,
            aggregateKeyType: 'IP',
          },
        },
        visibilityConfig: visibility(`${name}-RateLimitPerIp`),
      },
      managed(1, 'AWSManagedRulesCommonRuleSet'),
      managed(2, 'AWSManagedRulesKnownBadInputsRuleSet'),
    ],
  });
}
