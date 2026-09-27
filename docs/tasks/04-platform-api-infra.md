# Task 04 — Platform: HTTP & WebSocket API, local dev server, AWS CDK, ops scripts

> Runs in parallel with 02, 03 and 05, after task 01 has been committed. Work on branch `task/04-platform`. The goal is **ready to deploy on AWS**: `npx cdk deploy --all` from a clean account in under 20 minutes (NFR-06).

## 0. Read first

- `CLAUDE.md`: the standing rules, the env variables and the security rules.
- `docs/specification.md`: §3 (architecture), §5 (back end, in full), §11 (security and cost guards, in full), §12 (deployment, in full), and NFR-01, 04, 06 and 07.
- `packages/schema/src/api.ts` (route contracts, `AppConfig`, `WebRuntimeConfig`), `packages/store` (Store, EventBus, TraceStore, SecretStore, plus the Dynamo, S3 and Secrets Manager implementations) and `packages/schema/src/runtime.ts` (`executeRun`, `runAuthor`).

## 1. You own

```
services/api/     HTTP handlers, WS $connect/$disconnect, stream fan-out, author Lambda wrapper, local dev server
infra/            CDK v2 app: DataStack, ApiStack, WebStack
scripts/          user:create, secrets:set, kb:upload, scenarios:push, deploy, dev orchestration, hygiene helpers (reuse 01's)
docs/deploy.md    step-by-step deployment + teardown + troubleshooting
```

**Do not edit** `services/run/**` (tasks 02 and 03; you import `executeRun`, `runAuthor` and `loadKnowledgeIndex` from `@ica/run`, and the Run Lambda entry is `services/run/handler.ts`), `packages/*` (additive only, and report it), or `apps/web`. Until task 02 lands, `executeRun` is a stub that throws. Build and test against a **fake runner** that appends a scripted sequence of events built from `packages/schema/fixtures/run.sample.events.json`, so every route and the WebSocket path are proven.

## 2. HTTP API (`services/api/src/http/`)

Write one router Lambda (`api`) with a small, dependency-light router. Don't use Express inside Lambda; it's an API Gateway HTTP API payload v2.0 handler. It serves every route in the contract:

| Route | Behaviour |
|---|---|
| `GET /scenarios` | `publicScenarios` (from `@ica/scenarios`) merged with `store.listScenarios()` (private or authored) |
| `GET /scenarios/{id}` | public first, then the store |
| `POST /scenarios/author` | synchronous invoke of the **author Lambda** (it runs `runAuthor`, 60 s timeout); save a valid result as a private scenario |
| `POST /runs` | validate the scenario id and mode; enforce **`MAX_RUNS_PER_DAY`** (default 20) via `store.countRunsSince(startOfDayUtc)` → 429; create `RunMeta` and the `run.created` event; **async invoke** the Run Lambda (`InvocationType: 'Event'`, payload `{runId}`) |
| `GET /runs`, `GET /runs/{id}` | `RunMeta` |
| `GET /runs/{id}/events?after=&limit=` | `store.listEvents`, limit ≤ 500 |
| `POST /runs/{id}/approvals/{approvalId}` | the approval must exist and be `pending`, else 409; `edit` requires `editedArgs` (schema-validated by the runtime on consumption); append `approval.decision` with `decidedBy: {kind:'human', name: <Cognito username or email claim>, roleTitle: <from body, default 'Duty Manager'>}` and update the `ApprovalRecord` |
| `POST /runs/{id}/twists` | by `twistId` (must exist in the scenario) or `text` (run `screenInput` from `@ica/run` guardrails; if rejected → 422 with the screening) → append `twist.requested` |
| `POST /runs/{id}/control` | append `control.requested` (pause, resume, stop = kill-switch, set_speed 1–30) |
| `GET /runs/{id}/systems/{name}` | `store.getSystemState(runId, name)` |
| `GET /runs/{id}/export` | the full event log (or a presigned S3 URL if it's over 5 MB) plus the latest `EvidencePack` from the `record` state |
| `GET /config` | `AppConfig`: the brand pack (`BRAND_PACK` env JSON injected at deploy from `config/brand.local.json` if present, else `brand.default.json`), feature flags, `stations` (from `@ica/kb` `stations.json`, filtered to the brand's stations plus the scenario stations) and limits |
| `GET /evals/latest` | `store.getLatestEvalReport()` → 404 if there's none |

Cross-cutting requirements: validate every request body with Ajv against schemas derived from `api.ts`; send a consistent `ApiError`; use CORS for the CloudFront origin only (or `*` locally); emit structured JSON logs with the requestId and runId; don't return stack traces. Cold-start config, secrets and the brand pack are cached per container.

## 3. WebSocket API (`services/api/src/ws/`)

- `$connect`: read `token` and `runId` from the query string, **verify the Cognito JWT** with `aws-jwt-verify` (checking issuer, audience or client_id, token_use and expiry), then `store.putConnection(connectionId, runId)`. When `AUTH_MODE=none` (local only), skip verification.
- `$disconnect`: `store.deleteConnection`.
- Default route: ignore, or reply to `{action:'ping'}`.
- **Fan-out Lambda:** a DynamoDB Streams trigger with an **event-source filter to `SK` beginning with `EVT#`** (NEW_IMAGE), batch size 100, and a max batching window of 100 ms. Group records by runId, sort by seq, look up connections via the GSI, and `PostToConnection` `{kind:'events', runId, events}` in chunks of 128 KB or less. Delete the connection on `GoneException`. Report partial batch failures for retries. Don't send `SYS#` or `APR#` rows: the UI rebuilds state from events.

## 4. Local dev server (`npm run dev`), spec §12

`services/api/src/local/server.ts` is a Node HTTP and `ws` server on `:8787` that:
- Mounts **the same router** as the Lambda, by adapting Node requests to the HTTP API v2 event shape, so there's no duplicated logic.
- Uses `MemoryStore` + `MemoryEventBus` + `FsTraceStore` + `EnvSecretStore` (reads `.env`). The knowledge index comes from `data/index/` if it's built, else `data/fixtures/`.
- Runs `executeRun` **in-process** (fire-and-forget) instead of invoking a Lambda, and `runAuthor` in-process too.
- The WebSocket endpoint `ws://localhost:8787/ws?runId=` subscribes to the `EventBus` and pushes the same `{kind:'events'}` messages.
- `AUTH_MODE=none`.
- Optional persistence across restarts: `LOCAL_PERSIST=.local/store.json`, a snapshot on exit.
- The root `npm run dev` starts this server and the Vite dev server (`apps/web`) together (with `concurrently`) and writes `apps/web/public/config.json` = `{apiUrl:'http://localhost:8787', wsUrl:'ws://localhost:8787/ws', auth:{mode:'none'}}`.
- `npm run dev:aws` writes `config.json` from the deployed stack outputs (`aws cloudformation describe-stacks`) and starts Vite only.

## 5. CDK (`infra/`), spec §12. Three stacks, region default `eu-west-2`

**DataStack**
- A DynamoDB table: `PK`/`SK` strings, on-demand, **stream NEW_IMAGE**, TTL attribute `ttl`, point-in-time recovery on, and `GSI1` (`GSI1PK`, `GSI1SK`) for connections by run. RemovalPolicy `RETAIN` by default; `DESTROY` when the `-c ephemeral=true` context is set.
- Private S3 buckets, all block-public-access, SSE-S3 and enforce-SSL: `site`, `knowledge` (for the index), and `traces` (with a 90-day lifecycle expiry).
- Secrets Manager placeholders: `ica/llm` (a JSON object: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`), and `ica/search` (`TAVILY_API_KEY`/`BRAVE_API_KEY`, optional).
- Outputs: the table name and ARN, the stream ARN, and the bucket names.

**ApiStack**
- **Cognito:** a user pool with self-sign-up disabled, email sign-in, optional MFA (TOTP) and a strong password policy; a hosted UI domain prefix from context; an app client that is **public with PKCE** (no secret), uses the authorization code grant, has callback and logout URLs set to the CloudFront URL plus `http://localhost:5173`, and scopes `openid email profile`.
- **Lambdas** (Node 22, arm64, esbuild bundling via `NodejsFunction`, source maps on, log retention 30 days):
  - `api`: 512 MB, 29 s.
  - `author`: 1024 MB, 60 s.
  - `run`: **1769 MB, 15 min, reserved concurrency 2**, entry `services/run/handler.ts`. The knowledge bucket name is passed in env. If the local embedding model needs it, bundle the model files or fetch them from S3.
  - `wsConnect`, `wsDisconnect`, `fanout`: 256 MB.
  - Env on each: `TABLE_NAME`, `TRACES_BUCKET`, `KNOWLEDGE_BUCKET`, `LLM_PROVIDER`, `LLM_MODEL`, `LLM_FALLBACK_*`, `LLM_SECRET_ARN`, `MAX_RUNS_PER_DAY`, `RUN_BUDGET_USD`, `BRAND_PACK` and the feature flags. The values come from `.env` at synth time; secrets never do.
- **IAM, least privilege per function:**
  - `api` → table R/W, `lambda:InvokeFunction` on `run` and `author`, `s3:GetObject` on traces (presign).
  - `run` → table R/W, traces put, knowledge get, `secretsmanager:GetSecretValue` on `ica/llm` (+ `ica/search`), and `bedrock:InvokeModel` only when `LLM_PROVIDER` or the fallback is `bedrock`.
  - `fanout` → table read (GSI), `execute-api:ManageConnections` on the WS API.
  - `wsConnect` and `wsDisconnect` → table write on `WS#` rows.
- **HTTP API** with the JWT authorizer (Cognito issuer and the app-client audience) on **every route**, apart from none: `/config` is also authenticated. A stage throttle of 20 rps with bursts of 40. CORS for the CloudFront domain.
- **WebSocket API** with the routes above and a stage.
- **WAF** (spec §11): a regional WebACL on the HTTP API stage with the AWS managed common rule set plus a **rate-based rule of 100 requests per 5 minutes per IP**. The WebSocket stage is protected by $connect JWT verification and throttling, since WAF doesn't associate with WS APIs; document this.
- **Budgets:** an AWS Budgets monthly cost budget of **USD 20** with an email notification to the context `alertEmail` at 80% and 100%.
- **CloudWatch alarms:** Run Lambda errors ≥ 1, throttles ≥ 1, duration p95 > 12 min, fan-out iterator age > 60 s, and API 5xx > 5 in 5 min, each to an SNS topic with the email subscription.
- Outputs: `HttpApiUrl`, `WsApiUrl`, `UserPoolId`, `UserPoolClientId`, `CognitoDomain` and `Region`.

**WebStack**
- CloudFront with an S3 origin through **Origin Access Control**, `defaultRootObject: index.html`, and an SPA fallback: 403 or 404 → `/index.html` with a 200.
- A response-headers policy with strict CSP (`default-src 'self'`, `connect-src` = the API and WS origins plus the Cognito domain, `img-src 'self' data:`, `frame-ancestors 'none'`), HSTS, nosniff, referrer policy and a permissions policy.
- `BucketDeployment` of `apps/web/dist` plus a generated **`config.json`** (`WebRuntimeConfig` with `auth.mode:'cognito'` and the outputs from ApiStack).
- A CloudFront **WAF WebACL** (it must be in `us-east-1`). Either use a small cross-region stack, `WebWafStack` in us-east-1, or document the optional flag `-c cloudfrontWaf=true`. **Preferred: the cross-region stack via `crossRegionReferences: true`.**
- Output: `SiteUrl`.

Tests: CDK **assertions** tests (snapshot plus fine-grained) for each stack, covering reserved concurrency, the stream filter, the WAF rate rule, the budget, PKCE client settings and bucket public-access blocks. `npm run synth` must pass in CI with no AWS credentials, using dummy env and context. Run **cdk-nag** (AwsSolutions) with justified suppressions.

## 6. Ops scripts (`scripts/`), spec §12

- `npm run user:create -- you@example.com`: `AdminCreateUser` against the stack's pool (resolved from outputs) and prints the temporary password.
- `npm run secrets:set`: prompts for provider keys (hidden input) and `PutSecretValue` on `ica/llm`. It never writes keys to disk or logs.
- `npm run kb:upload`: syncs `data/index/` to the knowledge bucket, and the embedding model files if needed.
- `npm run scenarios:push`: validates and `putScenario` for `scenarios/private/*.json` (visibility private) against the deployed table.
- `npm run deploy`: builds the web app, then `cdk deploy --all --require-approval never`, then `kb:upload`, then prints the SiteUrl and the next steps.
- `docs/deploy.md`: prerequisites, the exact first-deploy sequence from spec §12, updating, teardown (including what `RETAIN` keeps), the cost notes, and troubleshooting (Bedrock model access, the Cognito domain being taken, the us-east-1 WAF).

## 7. Definition of done

- [ ] `npm test -w @ica/api -w @ica/infra` passes. The router tests cover every route (happy path plus auth, validation, 404, 409 and 429) against `MemoryStore`. The fan-out tests cover grouping and ordering, chunking and `GoneException` purging. The WS connect tests verify a JWT with a mocked JWKS.
- [ ] `npm run dev` works end to end with the fake runner: the web app can list scenarios, start a run, receive live events over WS, approve a proposal and fetch system state. Once task 02 merges, it works with the real runner without code changes.
- [ ] `npm run synth` is green; cdk-nag is clean or has justified suppressions; assertion tests are green.
- [ ] Scripts are implemented and `docs/deploy.md` is written. Everything is ready for the user's first `cdk deploy`, and nothing is deployed by you unless the user asks.
- [ ] Final report: contract changes, deviations (for example the WS and WAF note), and exact deployment prerequisites.
