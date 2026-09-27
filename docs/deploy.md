# Deploying the Incident Coordination Agent to AWS

This guide takes a clean AWS account to a working, single-user deployment in about 20 minutes (NFR-06). Everything is serverless: nothing runs, and almost nothing is billed, while you are not using it (see [Cost](#cost)).

## What gets deployed

| Stack | Region | Contents |
|---|---|---|
| `Ica-Data` | your region (default `eu-west-2`) | DynamoDB table (single table, stream, TTL, PITR, `GSI1`), S3 buckets `site`, `knowledge`, `traces` (90-day expiry), the Amazon S3 Vectors bucket + index for the knowledge embeddings (1536 dims, cosine), Secrets Manager placeholders `ica/llm` and `ica/search` |
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
| `KB_EMBEDDINGS`, `KB_VECTOR_STORE`, `KB_VECTOR_BUCKET`, `KB_VECTOR_INDEX`, `KB_EMBED_MODEL`, `KB_EMBED_DIMS`, `KB_EMBED_REGION`, `KB_RERANK`, `KB_RERANK_MODEL`, `KB_RERANK_REGION` | hybrid retrieval backends (see [Knowledge retrieval](#knowledge-retrieval)); `cohere`, `s3vectors`, the DataStack vector bucket/index, `eu.cohere.embed-v4:0`, `1536`, the stack region, `on`, `cohere.rerank-v3-5:0`, `eu-central-1` | knowledge loader |

### Knowledge retrieval

The Run and author Lambdas search the knowledge base with a **hybrid pipeline**: BM25 over the chunk files (in memory) **plus** a Cohere Embed v4 query embedding (`search_query`, cached per container) → Amazon S3 Vectors `QueryVectors` (top 50, metadata filter on collection and jurisdiction) → reciprocal rank fusion → collapse of several chunks of one document (`docId`) → **Cohere Rerank 3.5** over the top 30 → *k* hits with verbatim citation quotes. Any Bedrock, S3 Vectors or rerank error or timeout (embed ≈1.5 s, vector query ≈1.5 s, rerank ≈2 s) falls back to the previous stage (fused without rerank → BM25 only); it is logged (`"component":"knowledge","msg":"knowledge search degraded"`) and never fails a run.

| Piece | Where | Notes |
|---|---|---|
| Embeddings | Amazon Bedrock, **Cohere Embed v4** via the EU cross-region inference profile `eu.cohere.embed-v4:0`, 1536 dims, float | The bare `cohere.embed-v4:0` rejects on-demand calls. The profile routes **within EU regions only** (eu-north-1, eu-west-3, eu-south-1, eu-west-2, eu-south-2, eu-west-1, eu-central-1) |
| Vector store | **Amazon S3 Vectors** in the stack region (DataStack, CDK L1 `AWS::S3Vectors::VectorBucket` / `AWS::S3Vectors::Index`) | Key = `chunkId`; filterable metadata `collection`, `jurisdiction` (`ANY` if none), `sourceId`, `docId`, MEL `itemNumber`/`ataChapter`, precedent `phase`/`aircraftType` (≪ the 2 KB filterable limit); non-filterable `hash` (kb:upload idempotency). Text stays in the knowledge bucket |
| Rerank | Amazon Bedrock **Cohere Rerank 3.5** (`cohere.rerank-v3-5:0`) in **eu-central-1** (Frankfurt) | Not offered in eu-west-2. The query and ≤ 30 candidate chunks are sent to Frankfurt (EU). `-c rerankRegion=…` to change |
| IAM | Run + author roles | `bedrock:InvokeModel` on the inference-profile ARN and on `cohere.embed-v4:0` in the 7 routed regions, and on `cohere.rerank-v3-5:0` in eu-central-1; `s3vectors:QueryVectors` + `s3vectors:GetVectors` (needed for filtered queries) on the index ARN. No wildcards |

Modes (`-c knowledge=…`): `hybrid` (default), `bm25` (no Bedrock/S3 Vectors calls; `KB_EMBEDDINGS=none`), `local` (MiniLM inside the Lambda, only with `-c runNodeModules=@huggingface/transformers`, which installs the package with its linux-arm64 native binaries next to the bundle; needs Docker or a matching platform and adds ~100 MB).

**The index must be built with Cohere for the default deploy:** `KB_EMBEDDINGS=cohere npm run kb:build` (needs AWS credentials with Bedrock access in eu-west-2; ≈ 9.3M input tokens ≈ **USD 1.1 once**; resumable, cached by chunk-text hash in `data/raw/emb-cache-*.jsonl`, so reruns only pay for changed chunks). It writes the Lambda-loaded files (chunks + BM25, < 50 MB, no vectors) and `data/index/vectors/` for `kb:upload`. The loader **refuses** an index whose embedding model/dimension differs from `KB_EMBED_MODEL`/`KB_EMBED_DIMS` (`KnowledgeIndexMismatchError`), and `kb:upload` refuses a `local`/`openai` index. A BM25-only index (`KB_EMBEDDINGS=none`) is accepted and searched BM25-only.

Local development keeps working without AWS: the default `KB_EMBEDDINGS=local` (MiniLM, free) index is searched in memory (int8), `none` is BM25 only, and the committed fixture index needs no network. A Cohere-built `data/index/` used locally (`npm run dev`) searches its `vectors/` files in memory when no `KB_VECTOR_BUCKET` is set, embedding queries through Bedrock if AWS credentials are present (otherwise BM25 only); rerank is off locally unless `KB_RERANK=on`.

`npm run synth` makes no AWS calls: it unsets the AWS credential variables and only bundles and synthesises.

The brand pack comes from `config/brand.local.json` if present (git-ignored), else `config/brand.default.json`, and is compiled into the `api` Lambda at synth time together with `data/airports/stations.json` (if built).

## First deploy

```bash
npm install
KB_EMBEDDINGS=cohere npm run kb:build   # open data → data/index (~30 min; one-off ≈ USD 1.1 of Cohere embeddings)
npm run deploy              # see below
npm run user:create -- you@example.org
npm run secrets:set
```

`npm run deploy` does, in order:

1. Checks `.env` (alert e-mail, Cognito prefix, no `AUTH_MODE=none`, temperature ≤ 0.2).
2. Builds the web app (`npm run build -w @ica/web` → `apps/web/dist`). Without a build, a placeholder page is deployed.
3. `npx cdk bootstrap` for every environment the app uses: your region **and us-east-1** (skip with `-- --skip-bootstrap` once done).
4. `npx cdk deploy --all --require-approval never` (outputs saved to `.local/cdk-outputs.json`).
5. `npm run kb:upload` if `data/index/` exists (vectors to S3 Vectors, chunk/BM25 files to the knowledge bucket).
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
| `npm run kb:upload [-- --dry-run] [--keep-stale] [--delete]` | Checks the S3 Vectors index dimension, then `PutVectors` (batches of 200, ≤ 500 allowed) for new/changed vectors only (content hash in metadata) and `DeleteVectors` for keys no longer in the build (unless `--keep-stale`); then syncs the Lambda-loaded files of `data/index/` (not `vectors/`) to `s3://<KnowledgeBucket>/index/` (and `data/models/` to `models/`), skipping unchanged files; `--delete` removes stale objects. Prints counts. Refuses a `local`/`openai`-embedded index |
| `npm run scenarios:push [-- --dry-run]` | Validates `scenarios/private/*.json` and writes them to the table as private scenarios |
| `npm run synth` | Synthesises all stacks with cdk-nag checks, **without AWS credentials** (runs the CDK app directly, no account lookup) |
| `npm run dev:aws` | Writes `apps/web/public/config.json` from the `Ica-Api` outputs and starts Vite on :5173 against the deployed API (the Cognito client allows `http://localhost:5173` as callback) |

Scripts use `AWS_REGION` from `.env` and the standard AWS credential chain. `ICA_STACK_PREFIX` (default `Ica`) must match `-c prefix=…` if you changed it.

## Updating

- Code or configuration changes: `npm run deploy -- --skip-bootstrap` (or `cd infra && npx cdk deploy --all`). `.env` values are read at synth time, so changing e.g. `LLM_MODEL` requires a redeploy.
- Web only: `npm run build -w @ica/web && cd infra && npx cdk deploy Ica-Web`.
- Provider keys: `npm run secrets:set`. Lambdas cache secrets per container; new containers pick up the change (within minutes, or force it by redeploying).
- Knowledge index: `KB_EMBEDDINGS=cohere npm run kb:build && npm run kb:upload` (only changed chunks are re-embedded and re-put). New Lambda containers load the new chunk files; the vectors are live as soon as they are put.

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
| S3 Vectors storage (~19k × 1536-dim vectors ≈ 0.12 GB) + knowledge bucket (~50 MB) | < 0.01 |

Knowledge: the one-off embedding build is ≈ USD 1.1 (≈ 9.3M tokens × USD 0.12/M, Cohere Embed v4); each knowledge query costs ≈ USD 0.002 (one query embedding ≈ USD 0.000002 + one Cohere Rerank 3.5 query USD 0.002 + S3 Vectors query fractions of a cent); idle costs fractions of a cent.

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
| Knowledge answers are empty | `data/index/` was not uploaded: `KB_EMBEDDINGS=cohere npm run kb:build && npm run kb:upload` |
| Run Lambda logs `KnowledgeIndexMismatchError` | The uploaded index was built with another embedding model/dimension than the Lambdas query with. Rebuild with `KB_EMBEDDINGS=cohere` and `kb:upload`, or deploy with `-c knowledge=bm25` |
| Logs show `knowledge search degraded` (stage `rerank` or `embed`, `ThrottlingException`) | Default Bedrock quotas are tiny: **Cohere Rerank 3.5 = 3 requests/minute** (eu-central-1) and Cohere Embed v4 cross-region = 20 requests / 300k tokens per minute. Request increases in Service Quotas (*On-demand model inference requests per minute for Cohere Rerank 3.5*, *Global cross-region model inference requests per minute for Cohere Embed V4*). Until then searches fall back to fused (no rerank) or BM25 results |
| Logs show `knowledge search degraded` (stage `embed`/`rerank`, `AccessDeniedException`) | Enable model access for Cohere Embed v4 (EU profile) and Cohere Rerank 3.5 in eu-central-1 in the Bedrock console. Search still works (BM25 / without rerank) |
| `Export … cannot be deleted as it is in use` when changing stacks | A cross-stack output changed. Deploy the consuming stack first or use `cdk deploy --all` (CDK orders them) |
| No alarm/budget e-mails | Monitoring is off by default; deploy with `-c monitoring=true`, then confirm the SNS subscription e-mail |

### Rerank quota (Cohere Rerank 3.5)

On a new account, on-demand Cohere Rerank 3.5 in eu-central-1 is limited to **3 requests per minute**, and Service Quotas marks it not adjustable (Amazon Rerank 1.0 is 2/min). Retrieval therefore reranks **selectively**:
- It skips when BM25 and the vector search agree on the top document.
- It reuses cached results for repeated queries.
- It spends at most `KB_RERANK_RPM` (default 3) per container through a token bucket that never waits. When the budget is spent, the search keeps the fused hybrid order.

To lift the limit, open an AWS Support case (Service limit increase → Amazon Bedrock → eu-central-1 → "On-demand model inference requests per minute for Cohere Rerank 3.5"), then raise `KB_RERANK_RPM` and redeploy.
