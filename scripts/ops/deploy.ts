/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * `npm run deploy [-- --skip-bootstrap] [--skip-web]`: checks prerequisites, builds the web app, bootstraps CDK in
 * the target region and us-east-1 (CloudFront WAF), runs `cdk deploy --all --require-approval never`, uploads the
 * knowledge index if it is built, then prints the SiteUrl and the next steps.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, awsRegion, checkDomainPrefix, fail, isEmail, isMain, loadDotEnv, stackName } from './lib';

function run(cmd: string, args: string[], cwd = REPO_ROOT): void {
  console.log(`\n$ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', env: process.env });
  if (r.status !== 0) fail(`${cmd} ${args.join(' ')} failed (exit ${r.status ?? r.signal})`);
}

export function preflight(env: Record<string, string | undefined>): string[] {
  const problems: string[] = [];
  const email = env.ALERT_EMAIL ?? '';
  if (!isEmail(email) || email.endsWith('@example.com')) {
    problems.push('ALERT_EMAIL must be set in .env (budget and alarm notifications)');
  }
  const prefix = env.COGNITO_DOMAIN_PREFIX ?? '';
  const prefixProblem = prefix ? checkDomainPrefix(prefix) : 'COGNITO_DOMAIN_PREFIX must be set in .env';
  if (prefixProblem || prefix === 'ica-change-me')
    problems.push(prefixProblem ?? 'choose your own COGNITO_DOMAIN_PREFIX');
  if (env.AUTH_MODE === 'none')
    problems.push('AUTH_MODE=none is local-only; remove it from .env before deploying');
  const temp = Number(env.LLM_TEMPERATURE ?? '0.2');
  if (!(temp >= 0 && temp <= 0.2)) problems.push('LLM_TEMPERATURE must be ≤ 0.2');
  return problems;
}

function main() {
  loadDotEnv();
  const problems = preflight(process.env);
  if (problems.length) fail(`cannot deploy:\n  - ${problems.join('\n  - ')}`);
  const region = awsRegion();
  process.env.AWS_REGION = region;
  const args = process.argv.slice(2);

  if (!args.includes('--skip-web')) run('npm', ['run', 'build', '-w', '@ica/web']);
  if (!existsSync(join(REPO_ROOT, 'apps/web/dist/index.html'))) {
    console.warn('! apps/web/dist/index.html not found: a placeholder page will be deployed');
  }
  const infra = join(REPO_ROOT, 'infra');
  // Bootstraps every environment the app targets: the main region and us-east-1 (WebWafStack).
  if (!args.includes('--skip-bootstrap')) run('npx', ['cdk', 'bootstrap'], infra);
  mkdirSync(join(REPO_ROOT, '.local'), { recursive: true });
  const outputsFile = join(REPO_ROOT, '.local/cdk-outputs.json');
  run('npx', ['cdk', 'deploy', '--all', '--require-approval', 'never', '--outputs-file', outputsFile], infra);

  if (existsSync(join(REPO_ROOT, 'data/index'))) run('npm', ['run', 'kb:upload']);
  else
    console.warn(
      '! data/index/ not built: run `npm run kb:build && npm run kb:upload` for knowledge answers',
    );

  const outputs = JSON.parse(readFileSync(outputsFile, 'utf8')) as Record<string, Record<string, string>>;
  const siteUrl = outputs[stackName('Web')]?.SiteUrl ?? '(see the Ica-Web stack outputs)';
  console.log(`
✔ Deployed to ${region}.

  Site:     ${siteUrl}
  API:      ${outputs[stackName('Api')]?.HttpApiUrl ?? '?'}

Next steps:
  1. npm run user:create -- you@example.com     (prints a temporary password)
  2. npm run secrets:set                         (provider API key → Secrets Manager)
  3. Confirm the SNS subscription e-mail sent to ${process.env.ALERT_EMAIL}.
  4. Open ${siteUrl} and sign in.
`);
}

if (isMain(import.meta.url)) main();
