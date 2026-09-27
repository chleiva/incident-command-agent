# Ground Incident Coordination Agent

An open-source, serverless MVP of an **agentic airline incident-coordination system** on AWS.

A scenario describes a ground or pre-departure event (pushback damage, bird strike, APU inoperative…). An orchestrator and five specialist LLM agents (maintenance, ground, flight ops, passenger, incident record) coordinate the response through a hand-written ReAct loop, acting on **stateful mocked airline systems** under an **autonomy matrix enforced in code**. A React cockpit shows every effect live, a baseline replay shows how a human team would do it today, and an evaluation harness scores the agents.

> **Simulated systems · fictional carrier.** The only airline in this repository is the fictional **Northwind Air** (`NWD` flights, `NW-XXX` tails). Nothing here is operational guidance.

<!-- 90-second demo GIF goes here (docs/demo-script.md) -->

## Status

Foundation and contracts are in place; the runtime, domain, platform and web front end are being built (see [`docs/tasks/`](docs/tasks/README.md)).

## Quick start (local, no AWS)

```bash
nvm use                 # Node 22
npm install
cp .env.example .env    # set LLM_PROVIDER / LLM_MODEL and a key for live runs
npm run dev             # API + WebSocket on :8787, cockpit on :5173 (AUTH_MODE=none)
```

Headless: `npm run run:local -- --scenario s01-pushback-tug-contact --model claude-haiku-4-5`.

## Deploy to AWS

Prerequisites: an AWS account with admin credentials, Node 22, the AWS CDK CLI and one LLM provider key.

```bash
npm run kb:build
npx cdk bootstrap
npm run deploy
npm run user:create -- you@example.com
npm run secrets:set
```

Full steps, costs and teardown: `docs/deploy.md`.

## Repository map

| Path | Package | What |
|---|---|---|
| `apps/web` | `@ica/web` | React 18 + Vite cockpit, Storybook |
| `packages/schema` | `@ica/schema` | shared types, JSON Schemas, validators, event reducer, fixtures |
| `packages/store` | `@ica/store` | persistence: memory, DynamoDB, S3, Secrets Manager |
| `packages/ui-tokens` | `@ica/ui-tokens` | design tokens |
| `services/run` | `@ica/run` | Run Lambda: world engine, agents, tools, mocked systems, knowledge |
| `services/api` | `@ica/api` | HTTP + WebSocket API, local dev server |
| `scenarios` | `@ica/scenarios` | ten shipped scenarios (CC BY 4.0) |
| `data` | `@ica/kb` | knowledge-base build from open data |
| `evals` | `@ica/evals` | evaluation harness and lifetime budget ledger |
| `infra` | `@ica/infra` | AWS CDK stacks |
| `config` | | brand pack, model pricing |
| `docs` | | specification, architecture, ADRs, tasks |

## Documentation

- [Specification](docs/specification.md) · [Architecture](docs/architecture.md) · [ADRs](docs/adr/)
- [Shared contracts](packages/schema/CONTRACTS.md)
- [Build plan](docs/tasks/README.md) · [Contributing](CONTRIBUTING.md)

## Evaluation budget

Live evaluation is capped at **£10 for the lifetime of the project**, enforced in code with a committed ledger. `npm run eval` replays recorded traces for free; see [ADR 0006](docs/adr/0006-eval-budget-guard.md).

## Licences

- Code: [Apache-2.0](LICENSE).
- Scenarios and documentation: [CC BY 4.0](LICENSE-content).
- Third-party data keeps its own licence: see [NOTICE](NOTICE) and `data/SOURCES.md`.
