/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Synth-time configuration. Precedence: CDK context (`-c key=value`) > process env > repo `.env` > defaults.
 * Only an allow-list of NON-SECRET variables is ever copied into Lambda environments; provider keys live in
 * Secrets Manager (`npm run secrets:set`) and are never read here.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

export const REPO_ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));

/** Env variables passed to the runtime Lambdas (values from .env at synth time). Never secrets. */
export const LAMBDA_ENV_ALLOW_LIST = [
  'LLM_PROVIDER',
  'LLM_MODEL',
  'LLM_FALLBACK_PROVIDER',
  'LLM_FALLBACK_MODEL',
  'LLM_TEMPERATURE',
  'LLM_MAX_TOKENS',
  'RUN_BUDGET_USD',
  'RUN_HORIZON_MIN',
  'MAX_RUNS_PER_DAY',
  'KB_EMBEDDINGS',
  'SCREEN_WITH_LLM',
  'FEATURE_WEB_SEARCH',
  'FEATURE_LIVE_WEATHER',
  'FEATURE_NARRATOR',
] as const;

/** Names that must never end up in a template, even if someone adds them to the allow-list by mistake. */
const SECRET_PATTERN = /(KEY|SECRET|TOKEN|PASSWORD)/i;

export const PLACEHOLDER_ALERT_EMAIL = 'alerts@example.com';
export const PLACEHOLDER_DOMAIN_PREFIX = 'ica-change-me';

export interface InfraConfig {
  /** Stack name prefix (default `Ica`): Ica-Data, Ica-Api, Ica-Web, Ica-WebWaf. */
  prefix: string;
  region: string;
  account?: string;
  /** `-c ephemeral=true`: DESTROY data on stack deletion (default RETAIN). */
  ephemeral: boolean;
  alertEmail: string;
  cognitoDomainPrefix: string;
  /** CloudFront WebACL in us-east-1 (spec §11). Opt-in (`-c cloudfrontWaf=true`, ~USD 8/month idle); default off to keep idle cost near zero. */
  cloudfrontWaf: boolean;
  /** Opt-in regional WebACL on the Cognito user pool (`-c regionalWaf=true`, ~USD 8/month). */
  regionalWaf: boolean;
  /** Opt-in CloudWatch alarms + SNS + AWS Budgets notification (`-c monitoring=true`, ~USD 0.50/month). Default off. */
  monitoring: boolean;
  /** FEATURE_WEB_SEARCH=true: create the `ica/search` secret (USD 0.40/month) and grant it. */
  webSearch: boolean;
  /** Non-secret runtime settings for the Lambdas. */
  lambdaEnv: Record<string, string>;
  /** True when the primary or fallback provider is Bedrock (grants bedrock:InvokeModel to run/author). */
  bedrock: boolean;
  /** Brand pack JSON (config/brand.local.json if present, else brand.default.json). */
  brandPackJson: string;
  /** Compact stations JSON from data/airports/stations.json, if built. */
  stationsJson?: string;
  /** apps/web/dist if built, else a placeholder page. */
  webDistDir: string;
  webDistIsPlaceholder: boolean;
  /** Extra node_modules to install (not bundle) for the Run Lambda, e.g. native ONNX runtime. */
  runNodeModules: string[];
  repoRoot: string;
}

export type ContextGetter = (key: string) => unknown;

function readDotEnv(file: string | null): Record<string, string> {
  if (!file || !existsSync(file)) return {};
  return parseEnv(readFileSync(file, 'utf8')) as Record<string, string>;
}

function readJsonText(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

function compactStations(raw: string): string {
  const parsed: unknown = JSON.parse(raw);
  const list = (Array.isArray(parsed) ? parsed : (parsed as { stations?: unknown[] }).stations) ?? [];
  return JSON.stringify(
    (list as Record<string, unknown>[]).map(({ iata, name, lat, lon, country }) => ({
      iata,
      name,
      lat,
      lon,
      country,
    })),
  );
}

export interface LoadConfigOptions {
  context: ContextGetter;
  /** Path of the .env file (`null` = none, used by tests). Default `<repo>/.env`. */
  envFile?: string | null;
  processEnv?: Record<string, string | undefined>;
  repoRoot?: string;
}

export function loadInfraConfig(opts: LoadConfigOptions): InfraConfig {
  const root = opts.repoRoot ?? REPO_ROOT;
  const penv = opts.processEnv ?? process.env;
  const dot = readDotEnv(opts.envFile === undefined ? join(root, '.env') : opts.envFile);
  const ctx = (k: string) => {
    const v = opts.context(k);
    return v === undefined || v === null || v === '' ? undefined : String(v);
  };
  const pick = (ctxKey: string, envKey: string, fallback: string) =>
    ctx(ctxKey) ?? penv[envKey] ?? dot[envKey] ?? fallback;

  const lambdaEnv: Record<string, string> = {};
  for (const k of LAMBDA_ENV_ALLOW_LIST) {
    if (SECRET_PATTERN.test(k)) continue;
    const v = (penv[k] ?? dot[k])?.trim();
    if (v) lambdaEnv[k] = v;
  }
  const temp = Number(lambdaEnv.LLM_TEMPERATURE ?? '0.2');
  if (!(temp >= 0 && temp <= 0.2)) throw new Error('LLM_TEMPERATURE must be between 0 and 0.2 (NFR-03)');
  if (lambdaEnv.AUTH_MODE) delete lambdaEnv.AUTH_MODE;

  const brandPackJson =
    readJsonText(join(root, 'config/brand.local.json')) ??
    readJsonText(join(root, 'config/brand.default.json')) ??
    '';
  if (!brandPackJson) throw new Error('config/brand.default.json is missing');
  const stationsRaw = readJsonText(join(root, 'data/airports/stations.json'));

  const dist = join(root, 'apps/web/dist');
  const hasDist = existsSync(join(dist, 'index.html'));

  const bool = (v: string | undefined, def: boolean) => (v === undefined ? def : v === 'true' || v === '1');

  return {
    prefix: ctx('prefix') ?? 'Ica',
    region: pick('region', 'AWS_REGION', dot.AWS_REGION ?? 'eu-west-2'),
    account: ctx('account') ?? penv.CDK_DEFAULT_ACCOUNT,
    ephemeral: bool(ctx('ephemeral'), false),
    alertEmail: pick('alertEmail', 'ALERT_EMAIL', PLACEHOLDER_ALERT_EMAIL),
    cognitoDomainPrefix: pick('cognitoDomainPrefix', 'COGNITO_DOMAIN_PREFIX', PLACEHOLDER_DOMAIN_PREFIX),
    cloudfrontWaf: bool(ctx('cloudfrontWaf'), false),
    regionalWaf: bool(ctx('regionalWaf'), false),
    monitoring: bool(ctx('monitoring'), false),
    webSearch: lambdaEnv.FEATURE_WEB_SEARCH === 'true',
    lambdaEnv,
    bedrock: lambdaEnv.LLM_PROVIDER === 'bedrock' || lambdaEnv.LLM_FALLBACK_PROVIDER === 'bedrock',
    brandPackJson: JSON.stringify(JSON.parse(brandPackJson)),
    stationsJson: stationsRaw ? compactStations(stationsRaw) : undefined,
    webDistDir: hasDist ? dist : join(root, 'infra/assets/site-placeholder'),
    webDistIsPlaceholder: !hasDist,
    runNodeModules: (ctx('runNodeModules') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    repoRoot: root,
  };
}
