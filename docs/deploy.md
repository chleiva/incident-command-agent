# Deploying the Ground Incident Coordination Agent to AWS

This guide takes a clean AWS account to a working, single-user deployment in about 20 minutes (NFR-06). Everything is serverless: nothing runs, and almost nothing is billed, while you are not using it (see [Cost](#cost)).

## What gets deployed

| Stack | Region | Contents |
|---|---|---|
| `Ica-Data` | your region (default `eu-west-2`) | DynamoDB table (single table, stream, TTL, PITR, `GSI1`), S3 buckets `site`, `knowledge`, `traces` (90-day expiry), Secrets Manager placeholders `ica/llm` and `ica/search` |
| `Ica-WebWaf` | `us-east-1` | The CloudFront WAF WebACL (CloudFront-scoped WAF must live in us-east-1). Its ARN reaches `Ica-Web` through a CDK cross-region reference |
| `Ica-Web` | your region | CloudFront distribution (Origin Access Control, SPA fallback, strict CSP/HSTS headers, WAF), deployment of `apps/web/dist` |
| `Ica-Api` | your region | Cognito user pool, hosted UI and PKCE app client, HTTP API (JWT authorizer on every route, 20 rps / burst 40), WebSocket API, the Lambdas (`api`, `author`, `run`, `wsConnect`, `wsDisconnect`, `wsDefault`, `fanout`), DynamoDB stream fan-out, AWS Budgets (USD 20/month), CloudWatch alarms, and the SPA's `config.json` |

Deployment order (handled by CDK): `Ica-Data` → `Ica-WebWaf` → `Ica-Web` → `Ica-Api`. `Ica-Api` depends on `Ica-Web` because the Cognito callback URLs and CORS need the CloudFront domain; for the same reason `config.json` is deployed by `Ica-Api`, not `Ica-Web`.

## Lean defaults (owner decision)

The default deploy is tuned for **near-zero idle cost** and **no product spend limits** (budget limits apply only to the eval harness):

| Default | Opt in with | Idle cost when on |
|---|---|---|
| No CloudFront WAF (no `Ica-WebWaf` stack) | `-c cloudfrontWaf=true` | ~USD 8/month (web ACL + 3 rules) |
| No CloudWatch alarms, SNS topic or AWS Budgets notification | `-c monitoring=true` | ~USD 0.50/month |
| No `ica/search` secret | `FEATURE_WEB_SEARCH=true` in `.env` | USD 0.40/month |
| DynamoDB PITR off | — (edit `data-stack.ts`) | per GB-month |
| No Lambda reserved concurrency | — | — |
| `RUN_BUDGET_USD=0`, `MAX_RUNS_PER_DAY=0` (no limit) | set a positive value in `.env` | — |

What remains idle: the `ica/llm` secret (USD 0.40/month) and cents of DynamoDB/S3/CloudWatch Logs storage. Everything else is pay-per-request. Set a spend limit in the Anthropic console: that is the only cost that scales with use.

## Prerequisites

- An AWS account and credentials with administrator rights for the first deploy (`aws sts get-caller-identity` works).
- Node.js ≥ 22.12 and npm (the repo pins `.nvmrc`). The AWS CDK CLI is installed by `npm install` (`npx cdk`), no global install needed. Docker is **not** needed (Lambdas are bundled with esbuild).
- One LLM provider key (Anthropic by default; OpenAI works too), or Bedrock model access (see below).
- An e-mail address for the budget and alarm notifications.
- A **globally unique** Cognito hosted-UI prefix, e.g. `ica-yourname-1234` (lowercase letters, digits, hyphens; must not contain `aws`, `amazon` or `cognito`).
- Lambda concurrency: the Run Lambda reserves 2 concurrent executions, and AWS requires at least 10 to stay unreserved. Brand-new accounts sometimes have a total limit of 10; if so, request an increase of "Concurrent executions" in Service Quotas before deploying.
- Bedrock only (`LLM_PROVIDER=bedrock` or a Bedrock fallback): enable access to the chosen model in the Bedrock console, in your region, first.

## Configure

```bash
cp .env.example .env
```

Set at least:

| Variable | Example | Notes |
|---|---|---|
| `LLM_PROVIDER`, `LLM_MODEL` | `anthropic`, `claude-sonnet-5` | Copied into the Lambda environment at synth time |
| `AWS_REGION` | `eu-west-2` | Any region with Cognito, API Gateway WebSockets and (optionally) Bedrock |
| `ALERT_EMAIL` | `you@example.org` | Alarm and budget e-mails when monitoring is enabled (`-c monitoring=true`) |
| `COGNITO_DOMAIN_PREFIX` | `ica-yourname-1234` | Hosted UI at `https://<prefix>.auth.<region>.amazoncognito.com` |

Optional: `LLM_FALLBACK_PROVIDER`/`LLM_FALLBACK_MODEL`, `RUN_BUDGET_USD`, `RUN_HORIZON_MIN`, `MAX_RUNS_PER_DAY` (0 = no limit, the default; otherwise the API returns 429 above it). `RUN_BUDGET_USD` also defaults to 0 = no limit, `FEATURE_*`, `KB_EMBEDDINGS`, `SCREEN_WITH_LLM`. Only these non-secret settings are copied into Lambda environments (`infra/src/config.ts`, `LAMBDA_ENV_ALLOW_LIST`). **API keys in `.env` are never deployed**: in AWS they live in Secrets Manager.

### Lambda runtime environment

The ApiStack sets these on the Run and author Lambdas; `services/run/handler.ts` and `services/api/src/lambda/author.ts` read them through the same helpers (`lambdaSecretIds` in `@ica/store`, `knowledgeS3PathFromEnv` in `@ica/run`):

| Variable | Value | Read by |
|---|---|---|
| `TABLE_NAME`, `TRACES_BUCKET` | DataStack table / traces bucket | store, trace store |
| `KNOWLEDGE_BUCKET` | knowledge bucket; the index is loaded from `s3://$KNOWLEDGE_BUCKET/index` (where `npm run kb:upload` puts it), once per container | knowledge loader |
| `LLM_SECRET_ARN` | `ica/llm` JSON `{ANTHROPIC_API_KEY, OPENAI_API_KEY}` | LLM adapters (SecretStore) |
| `SEARCH_SECRET_ARN` | `ica/search` JSON `{TAVILY_API_KEY, BRAVE_API_KEY}` | copied into `process.env` at cold start when `FEATURE_WEB_SEARCH=true` (for `web_search`) |
| `KB_EMBEDDINGS` | `none` by default in Lambda (see below) | knowledge loader |

**Retrieval in Lambda is BM25-only by default.** The local query embedder (transformers.js + `onnxruntime-node`) needs a native binding that cannot be loaded from an esbuild bundle, so `@huggingface/transformers`, `onnxruntime-node`, `onnxruntime-web` and `sharp` are left out of the Run/author bundles and the Lambdas get `KB_EMBEDDINGS=none`. The index built with `KB_EMBEDDINGS=local` still works: its BM25 postings are used and its vectors are ignored. Hybrid retrieval stays available locally (`npm run dev`, evals). Options if you need it in AWS:

- `KB_EMBEDDINGS=openai` (or `bedrock`) for both `kb:build` and the Lambdas: query embeddings go over HTTPS (the OpenAI key is read from `ica/llm` and copied into `process.env`).
- Experimental: `npx cdk deploy -c runNodeModules=@huggingface/transformers …` installs the package (with its linux-arm64 native binaries) next to the bundle instead; the Lambdas then get `KB_EMBEDDINGS=local` and `KB_MODEL_CACHE=HF_HOME=/tmp/hf`, and the MiniLM model is downloaded from the Hugging Face hub into `/tmp` at cold start. This needs Docker or a matching platform for the install and adds ~100 MB to the package; check the unzipped 250 MB limit.

`npm run synth` makes no AWS calls: it unsets the AWS credential variables and only bundles and synthesises.

The brand pack comes from `config/brand.local.json` if present (git-ignored), else `config/brand.default.json`, and is compiled into the `api` Lambda at synth time together with `data/airports/stations.json` (if built).

## First deploy

```bash
npm install
npm run kb:build            # downloads open data and builds data/index (~10 min; optional but recommended)
npm run deploy              # see below
npm run user:create -- you@example.org
npm run secrets:set
```

`npm run deploy` does, in order:

1. Checks `.env` (alert e-mail, Cognito prefix, no `AUTH_MODE=none`, temperature ≤ 0.2).
2. Builds the web app (`npm run build -w @ica/web` → `apps/web/dist`). Without a build, a placeholder page is deployed.
3. `npx cdk bootstrap` for every environment the app uses: your region **and us-east-1** (skip with `-- --skip-bootstrap` once done).
4. `npx cdk deploy --all --require-approval never` (outputs saved to `.local/cdk-outputs.json`).
5. `npm run kb:upload` if `data/index/` exists.
6. Prints the SiteUrl and the next steps.

The equivalent manual sequence (spec §12) is:

```bash
npm run build -w @ica/web
cd infra && npx cdk bootstrap && npx cdk deploy --all && cd ..
npm run kb:upload
npm run user:create -- you@example.org     # prints a temporary password
npm run secrets:set                        # hidden prompt; writes ica/llm
```

Then confirm the SNS subscription e-mail ("AWS Notification - Subscription Confirmation"), open the SiteUrl, sign in with the temporary password, set a new one and, optionally, enrol a TOTP authenticator.

### The ops scripts

| Command | What it does |
|---|---|
| `npm run user:create -- you@example.org` | `AdminCreateUser` in the deployed pool (from the `Ica-Api` outputs), e-mail verified, invitation suppressed; prints a temporary password |
| `npm run secrets:set [-- --search]` | Hidden prompts for `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` (and `TAVILY_API_KEY`/`BRAVE_API_KEY` with `--search`); Enter keeps the current value. `PutSecretValue` only; nothing is written to disk or printed |
| `npm run kb:upload [-- --delete] [--dry-run]` | Syncs `data/index/` to `s3://<KnowledgeBucket>/index/` (and `data/models/` to `models/` if present), skipping unchanged files |
| `npm run scenarios:push [-- --dry-run]` | Validates `scenarios/private/*.json` and writes them to the table as private scenarios |
| `npm run synth` | Synthesises all stacks with cdk-nag checks, **without AWS credentials** (runs the CDK app directly, no account lookup) |
| `npm run dev:aws` | Writes `apps/web/public/config.json` from the `Ica-Api` outputs and starts Vite on :5173 against the deployed API (the Cognito client allows `http://localhost:5173` as callback) |

Scripts use `AWS_REGION` from `.env` and the standard AWS credential chain. `ICA_STACK_PREFIX` (default `Ica`) must match `-c prefix=…` if you changed it.

## Updating

- Code or configuration changes: `npm run deploy -- --skip-bootstrap` (or `cd infra && npx cdk deploy --all`). `.env` values are read at synth time, so changing e.g. `LLM_MODEL` requires a redeploy.
- Web only: `npm run build -w @ica/web && cd infra && npx cdk deploy Ica-Web`.
- Provider keys: `npm run secrets:set`. Lambdas cache secrets per container; new containers pick up the change (within minutes, or force it by redeploying).
- Knowledge index: `npm run kb:build && npm run kb:upload`.

## Teardown

```bash
cd infra && npx cdk destroy --all
```

By default data is **retained** (`RemovalPolicy.RETAIN`, and deletion protection on the user pool). After `destroy`, these remain and keep costing a little until you delete them by hand:

- the DynamoDB table (`Ica-Data-Table…`), PITR backups included;
- the three S3 buckets (`ica-data-sitebucket…`, `…knowledgebucket…`, `…tracesbucket…`): empty then delete;
- the Cognito user pool: disable deletion protection, then delete;
- CloudWatch log groups of the Lambdas and the HTTP API access logs (30-day retention).

The secrets `ica/llm` and `ica/search` are scheduled for deletion (7–30-day recovery window). To redeploy immediately under the same names: `aws secretsmanager delete-secret --secret-id ica/llm --force-delete-without-recovery` (same for `ica/search`).

For throwaway environments deploy with `npx cdk deploy --all -c ephemeral=true`: everything (table, buckets and their objects, user pool) is destroyed with the stacks.

## Security model

- Single user, admin-created (self sign-up disabled), strong password policy, optional TOTP MFA, hosted UI with authorization code + PKCE (public client, no secret).
- HTTP API: API Gateway JWT authorizer (Cognito issuer, app-client audience) on **every** route, including `/config`; stage throttling 20 rps, burst 40; CORS only for the CloudFront origin and `http://localhost:5173` (for `dev:aws`). The router also rejects requests without JWT claims.
- WebSocket API: the `$connect` Lambda verifies the Cognito JWT from `?token=` with `aws-jwt-verify` (signature via JWKS, issuer, audience/client id, `token_use`, expiry) and that the run exists; stage throttling 20 rps, burst 40.
- **WAF (deviation from the spec wording).** AWS WAF cannot be associated with API Gateway **HTTP** or **WebSocket** APIs (only REST APIs, CloudFront, ALB, AppSync, Cognito and a few others). So:
  - CloudFront has the WebACL (`Ica-WebWaf`, us-east-1): rate limit 100 requests / 5 min / IP, AWS managed common rule set and known-bad-inputs rules.
  - The APIs are protected by JWT authorization plus stage throttling (above) and the per-day run limit.
  - Optional: `-c regionalWaf=true` adds the same WebACL, regionally, on the Cognito user pool (the only unauthenticated endpoint). Off by default for cost.
  - To put the API itself behind WAF you would route it through CloudFront (a `/api/*` behaviour) — not done here.
- Least-privilege IAM per function (`infra/src/stacks/api-stack.ts`); WebSocket connect/disconnect can only touch `WS#` rows (DynamoDB `LeadingKeys` conditions); Bedrock permissions exist only when Bedrock is configured.
- Private S3 buckets (block public access, SSE-S3, TLS-only); CloudFront reads the site bucket through OAC.
- Strict response headers: CSP (`default-src 'self'`, `connect-src` limited to the regional API Gateway, Cognito and S3 endpoints, `frame-ancestors 'none'`), HSTS, nosniff, referrer policy, permissions policy.
- `npm run synth` runs cdk-nag (AwsSolutions). Every suppression is justified in `infra/src/nag.ts`.

## Cost

Idle (no runs), default deploy, approximate list prices:

| Item | USD / month |
|---|---|
| Secrets Manager (`ica/llm`) | 0.40 |
| DynamoDB, S3, CloudWatch Logs storage; CloudFront, Cognito (free tier), APIs, Lambda (pay per use) | cents |
| Opt-in CloudFront WebACL (`-c cloudfrontWaf=true`) | ≈ 8 |
| Opt-in monitoring (`-c monitoring=true`: 5 alarms, SNS, Budgets) | ≈ 0.50 |
| Opt-in `ica/search` secret (`FEATURE_WEB_SEARCH=true`) | 0.40 |
| Opt-in regional WebACL (`-c regionalWaf=true`) | ≈ 8 |

Per run: Lambda and DynamoDB cost cents; LLM tokens are the real cost (roughly USD 0.6–2 per full run). The product applies **no spend limits** by default (owner decision; only the eval harness is capped), so set a spend limit in your LLM provider's console.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Ica-Api` fails on `UserPoolDomain`: *domain already exists* | The Cognito prefix is taken (globally). Pick another `COGNITO_DOMAIN_PREFIX`, redeploy |
| `Ica-WebWaf` / `Ica-Web` fail with *SSM parameter* or *bootstrap* errors, or `This stack uses assets…` in us-east-1 | us-east-1 is not bootstrapped. Run `cd infra && npx cdk bootstrap` (it bootstraps both regions), then redeploy |
| *Specified ReservedConcurrentExecutions … decreases account's UnreservedConcurrentExecution below its minimum value of [10]* | Request a Lambda concurrent-executions quota increase (new accounts can start at 10) |
| Runs fail immediately with a provider auth error | `npm run secrets:set` was not run, or the key is wrong. Check the Run Lambda logs (`/aws/lambda/Ica-Api-RunFn…`) |
| Bedrock `AccessDeniedException` | Enable model access in the Bedrock console for that model **in your region**; check `LLM_MODEL` is a model or inference-profile id available there |
| Browser shows a Cognito `redirect_mismatch` | The SPA must use `redirectUri` from `/config.json` (the CloudFront URL with a trailing `/`, or `http://localhost:5173/` for `dev:aws`) |
| API returns 401 | The token is missing/expired or not issued by this pool/client; sign in again |
| API returns 429 `daily_run_limit` | You set a non-zero `MAX_RUNS_PER_DAY` and reached it (UTC day). Set it to 0 (no limit) or raise it, and redeploy |
| Live events do not arrive | Check the fan-out Lambda logs and the `FanoutIteratorAge` alarm; the client should re-fetch `GET /runs/{id}/events?after=` on a seq gap |
| Knowledge answers are empty | `data/index/` was not uploaded: `npm run kb:build && npm run kb:upload` |
| `Export … cannot be deleted as it is in use` when changing stacks | A cross-stack output changed. Deploy the consuming stack first or use `cdk deploy --all` (CDK orders them) |
| No alarm/budget e-mails | Monitoring is off by default; deploy with `-c monitoring=true`, then confirm the SNS subscription e-mail |
