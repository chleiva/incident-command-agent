/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * CDK entry (`npm run synth`, `npx cdk deploy --all`). Synth needs no AWS credentials: without them the stacks
 * are environment-agnostic on the account and use placeholder alert email / Cognito prefix (deploy refuses those).
 */
import { buildApp } from '../src/app';
import { PLACEHOLDER_ALERT_EMAIL, PLACEHOLDER_DOMAIN_PREFIX } from '../src/config';

// `npm run synth` runs this file directly (not through the CDK CLI) so no AWS credential or account lookup ever
// happens; the CDK CLI sets CDK_OUTDIR itself for deploys.
const { app, config } = buildApp({ appProps: { outdir: process.env.CDK_OUTDIR ?? 'cdk.out' } });

const warn = (msg: string) => console.warn(`[ica] ${msg}`);
if (config.alertEmail === PLACEHOLDER_ALERT_EMAIL)
  warn('ALERT_EMAIL not set: using a placeholder (set it before deploying).');
if (config.cognitoDomainPrefix === PLACEHOLDER_DOMAIN_PREFIX) {
  warn('COGNITO_DOMAIN_PREFIX not set: using a placeholder (set a globally unique prefix before deploying).');
}
if (config.webDistIsPlaceholder)
  warn('apps/web/dist not built: deploying a placeholder page (npm run deploy builds it).');

app.synth();
