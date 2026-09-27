# Contributing

Thanks for helping. Please read [`CLAUDE.md`](CLAUDE.md) (standing rules) and [`docs/specification.md`](docs/specification.md) first; shared contracts are described in [`packages/schema/CONTRACTS.md`](packages/schema/CONTRACTS.md).

## Setup

```bash
nvm use            # Node 22
npm install        # also installs the pre-commit hook
npm run typecheck && npm run lint && npm test
```

Optional: install [gitleaks](https://github.com/gitleaks/gitleaks) so the pre-commit hook scans for secrets locally (CI always does). Create `config/private-words.txt` (git-ignored, one term per line) to block names that must never appear in the tree.

## Ground rules

- **Anonymity.** The fictional carrier Northwind Air (`NWD` flights, `NW-XXX` tails) is the only identity in the tree. No client, airline or consultancy names, no real personal data, no proprietary manual text (IATA IGOM/AHM, ICAO Doc 10121, OEM manuals, SKYbrary text). Never invent report ids such as ASRS ACNs.
- **Authority lives in code.** Tool tiers (`execute` / `propose` / `forbidden`) are enforced by the runtime. Changing the autonomy matrix is a deliberate change: update the evals too.
- **Untrusted content is data.** Never interpolate scenario, user or tool text into a system prompt.
- **Costs.** `npm test` makes zero live LLM calls. Live evaluation has a lifetime £10 cap (ADR 0006) and needs the owner's explicit go-ahead.
- **Licences.** Code is Apache-2.0 with the header on every `.ts/.tsx/.mjs/.js` file (`npm run format` adds it). Scenarios and docs are CC BY 4.0. Record every data source in `data/SOURCES.md`.
- **Contracts.** `packages/schema` and `packages/store` change additively (new optional fields, new event types). Document additions in `CONTRACTS.md`.

## Workflow

- Branch from `main`; conventional commits (`feat(run): …`, `fix(web): …`).
- Keep functions pure where possible; tests next to code (`*.test.ts`); no network in tests.
- Before a PR: `npm run typecheck && npm run lint && npm run lint:headers && npm test` and, for anything touching data or docs, `npm run hygiene`.

## Adding a scenario

1. Copy an existing file in `scenarios/public/` (or write one in `scenarios/private/`, which is git-ignored).
2. Fictional carrier data only; real IATA airports; `inspiredBy` only with references you verified.
3. `npm run scenarios:validate` (validates and regenerates `scenarios/public/index.gen.ts`).
4. Open a PR with the "New scenario" issue template linked.

## Adding a tool

One module per tool in `services/run/tools/`, exporting a `ToolDefinition` (strict input schema, tier, system, roles, `refs`, `outputScreen` where relevant). Add it to `domainTools`, unit-test the happy path and rule violations, and update the autonomy matrix and evals if the tier is new.
