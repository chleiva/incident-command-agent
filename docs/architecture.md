# Architecture

This is the implementation view of spec §3 and §5. Contracts live in `packages/schema` (see `packages/schema/CONTRACTS.md`) and `packages/store`.

## Components

```mermaid
flowchart LR
  subgraph Browser
    SPA["React SPA (apps/web)<br/>applyEvent projection"]
  end
  subgraph AWS["AWS (eu-west-2)"]
    CF["CloudFront + S3 site<br/>(optional WAF, us-east-1)"]
    COG["Cognito user pool<br/>(hosted UI, PKCE)"]
    HTTP["HTTP API<br/>JWT authorizer, throttling"]
    WS["WebSocket API<br/>JWT on $connect"]
    API["api Lambda<br/>(router)"]
    AUTH["author Lambda<br/>runAuthor"]
    RUN["Run Lambda<br/>world engine + runAgent<br/>15 min"]
    FAN["fan-out Lambda"]
    DDB[("DynamoDB single table<br/>stream NEW_IMAGE")]
    S3T[("S3 traces")]
    S3K[("S3 knowledge index")]
    SM["Secrets Manager<br/>ica/llm, ica/search"]
  end
  LLM["LLM provider<br/>Anthropic / OpenAI / Bedrock"]

  SPA -->|static| CF
  SPA -->|login| COG
  SPA -->|JWT| HTTP --> API
  SPA <-->|events| WS
  API -->|sync invoke| AUTH
  API -->|async invoke {runId}| RUN
  API -->|append events, approvals| DDB
  RUN -->|append events + SYS rows (transaction)| DDB
  RUN --> LLM
  AUTH --> LLM
  RUN --> S3T
  RUN -->|cold start| S3K
  RUN --> SM
  DDB -->|stream, SK begins_with EVT#| FAN -->|PostToConnection| WS
```

Locally (`npm run dev`), `MemoryStore` + `MemoryEventBus` replace DynamoDB and its stream, an in-process runner replaces the Run Lambda, and a Node `ws` server on :8787 replaces API Gateway (`AUTH_MODE=none`).

## Event flow

1. `POST /runs` → the API creates `RunMeta`, appends `run.created` and async-invokes the Run Lambda with `{runId}`.
2. The Run Lambda seeds the mock systems (`system.mutation` events), starts the world clock and `runAgent('orchestrator')`. Each tool result is appended **with its mutations in one transaction**; `seq` is gap-free per run.
3. The DynamoDB stream triggers the fan-out Lambda, which groups `EVT#` rows by run, sorts by `seq` and pushes `{kind:'events'}` to every connection of that run.
4. The browser hydrates with `GET /runs/{id}/events?after=0`, then applies WebSocket batches by `seq` (duplicates dropped, gaps re-fetched).

## Approvals

```mermaid
sequenceDiagram
  participant A as Agent (Run Lambda)
  participant S as Store (DynamoDB)
  participant F as Fan-out → WebSocket
  participant U as Browser
  participant P as api Lambda
  A->>S: append agent.proposal + put APR# (pending)
  S-->>F: stream EVT#
  F-->>U: {kind:'events'} → DecisionCard
  Note over A: this agent blocks; other agents keep running
  U->>P: POST /runs/{id}/approvals/{approvalId} {decision}
  P->>S: check APR# pending (else 409)
  P->>S: append approval.decision (decidedBy: human) + update APR#
  S-->>F: stream EVT#
  F-->>U: card shows approver
  A->>S: next iteration: listEvents(after=lastSeq) finds approval.decision
  A->>A: approve → run original args · edit → validate + run editedArgs · reject → tool result "rejected by …"
  A->>S: append agent.tool_result (+ mutations)
```

Twists (`twist.requested`) and control commands (`control.requested`: pause, resume, stop = kill-switch, set_speed) follow the same pattern: the API writes the request event and the Run Lambda drains it on its next iteration, emitting the effect events (`world.twist`, `run.paused`, `run.resumed`, `run.speed_changed`, `run.completed{reason:'stopped'}`).

## Packages

| Package | Role |
|---|---|
| `@ica/schema` | TypeBox schemas → types, JSON Schema, Ajv validators, `applyEvent`, fixtures |
| `@ica/store` | `Store`/`EventBus`/`TraceStore`/`SecretStore` + memory, DynamoDB, S3, Secrets Manager |
| `@ica/run` | Run Lambda: runtime, llm, world, guardrails, baseline (task 02); systems, tools, agents, knowledge (task 03) |
| `@ica/api` | HTTP router, WebSocket handlers, fan-out, local dev server |
| `@ica/web` | cockpit SPA |
| `@ica/infra` | CDK stacks |
| `@ica/evals` | harness, ledger |
| `@ica/kb` | knowledge-base build |
| `@ica/scenarios` | shipped scenarios |
| `@ica/ui-tokens` | design tokens |
