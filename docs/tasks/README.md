# Build plan — task breakdown

The full specification is in [`../specification.md`](../specification.md). The standing rules for every agent are in [`/CLAUDE.md`](../../CLAUDE.md).

## Tasks

| # | Task | Owns (directories) | Runs |
|---|---|---|---|
| 01 | [Foundation & contracts](01-foundation-contracts.md) | root config, `packages/schema`, `packages/store`, `scenarios/` (package shell + ids), `config/`, `.github/`, `docs/adr`, licence/hygiene files, registry stubs in `services/run` | **First, alone** |
| 02 | [Agent runtime, world engine & evaluation](02-agent-runtime-world-evals.md) | `services/run/{runtime,llm,world,guardrails,baseline}`, `services/run/handler.ts`, `services/run/index.ts`, `evals/` | Parallel, after 01 |
| 03 | [Airline domain: mocked systems, tools, roles, scenarios, knowledge](03-domain-systems-tools-knowledge.md) | `services/run/{systems,tools,agents,knowledge}`, `scenarios/public/*`, `data/` | Parallel, after 01 |
| 04 | [Platform: API, WebSocket, local dev server, AWS CDK, ops scripts](04-platform-api-infra.md) | `services/api`, `infra/`, `scripts/` | Parallel, after 01 |
| 05 | [Web front end & design system](05-web-frontend.md) | `apps/web`, `packages/ui-tokens`, `docs/demo-script.md` | Parallel, after 01 |
| 06 | [Align with the final one-page brief](06-brief-alignment.md) | cross-cutting changes (rename, UI labels, glossary, invalidation, idempotency) | **Last, alone**, after the integration pass |
| 07 | [Live network home, flight-first reporting, airborne incidents](07-live-network-and-airborne.md) | `packages/network` (new), airborne systems/tools/scenarios, web home | After the hybrid-search and live-run fixes merge; phase A then phase B |

## Execution order

```
01 Foundation ──► commit on main ──┬─► 02 Runtime + evals   (branch task/02-runtime)
                                   ├─► 03 Domain            (branch task/03-domain)
                                   ├─► 04 Platform          (branch task/04-platform)
                                   └─► 05 Web               (branch task/05-web)
                                             │
                                             ▼
                              Integration pass (orchestrator), see below
```

- **Task 01 must finish, and be committed on `main`, before any other task starts.** It turns the contracts into compiling code (types, JSON schemas, store interface, registries). Tasks 02–05 then build against real code, not prose.
- Tasks 02–05 can run in parallel, either as subagents in their own git worktree (`isolation: "worktree"`) or one after another in the order 03 → 02 → 04 → 05. They touch disjoint directories, so merges should be conflict-free apart from `package-lock.json`. Resolve that by re-running `npm install`.
- **Contract changes.** If a task needs to change anything in `packages/schema` or `packages/store`, it must make the change *additively* (new optional fields, new event types) and record it in its final report under "Contract changes". Breaking changes are not allowed during the parallel phase. The integration pass reconciles them.
- Each task ends with a **final report**: what was built, what was deferred and why, contract changes, how to verify, and any live LLM spend.

## Integration pass (orchestrator, after 02–05 merge)

1. Merge `task/03-domain`, `task/02-runtime`, `task/04-platform` and `task/05-web` into `main`, in that order. Run `npm install`.
2. `npm run typecheck && npm run lint && npm test` must be green across all workspaces.
3. `npm run dev`: log in (local auth mode), start scenario `s01-pushback-tug-contact` in agent mode with `LLM_MODEL=claude-haiku-4-5` and approve, edit and reject one proposal each. Inject a twist, run the paired baseline side by side, refresh the browser mid-run (the replay must be gap-free), and export the evidence pack.
4. `npm run eval -- --tier baseline` must pass at zero cost. Then do the **single planned live recording**: `npm run eval -- --tier smoke --live`. It draws on the **lifetime £10 budget**, so check the pre-flight estimate with the owner first, and commit `evals/ledger.json` and the recorded fixtures right after. `npm run eval` (replay) must then pass at £0.
5. `npx cdk synth --all` must pass. Then do a deploy dry-run checklist review against docs/deploy.md.
6. Run the anonymity scan (`npm run hygiene`) over the full tree and history.
7. Update README and CLAUDE.md with anything that changed. Capture the README GIF (a manual step for the user).
