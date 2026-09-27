# Task 06 — Align the build with the final one-page brief

> Runs **after** tasks 01–05 and the integration pass have been merged into `main`. It is the only task running. Work directly on `main` in logical commits.
>
> **Changes only, no new features beyond what is listed here.** Every item below is a deliberate product change from the owner.

## 0. Read first

- `CLAUDE.md` for the rules. Keep the anonymity, authority-in-code and cost rules in force.
- `docs/specification.md` §4 (UI) and §6 (runtime).
- `packages/schema/CONTRACTS.md`. Contract changes stay **additive** and are logged in §11.

## 1. Changes

### 1.1 Rename the product
Rename "Incident Command Agent" to **"Ground Incident Coordination Agent"** everywhere user-visible or descriptive:
- the web title bar and `<title>`
- `README.md`
- the brand default (`config/brand.default.json`, adding a `productName` field if there isn't one)
- `CLAUDE.md`
- `docs/*` headings
- the Storybook title
- CDK stack descriptions
- `package.json` descriptions

**Keep** the package scope `@ica/*`, stack ids, the repo name and the table and bucket names, so deploys and imports don't break. Mention this in `docs/adr/` as a short note.

### 1.2 Provisional defect interpretation and "Decided by"
- Any model interpretation of a defect (maintenance agent output, cards, report text, context pack) is shown as **"Provisional reading — unconfirmed"**. It is **never** shown as a status such as "non-deferrable", "deferrable", "airworthy" or "AOG".
- The maintenance role prompt and its `reportSchema` carry this as `provisionalReading: {text, confidence?, unconfirmed: true}`. Output screening blocks status-like claims in agent-authored text. The UI renders the label verbatim.
- The airworthiness decision UI gets a **"Decided by: [role]"** field. Populate it **only** from the human decision-capture tool (`record_engineering_decision`, whose `decidedBy` is the human approver). Leave it empty ("Awaiting certifying staff") until that event exists. It must never be derived from agent text.

### 1.3 Presenter control: demonstrate a forbidden call
- Add a command-palette action, **"Demonstrate blocked action"**. It sends `POST /runs/{id}/control {action: 'demo_forbidden', tool?: 'defer_defect'}`, an additive control action.
- The runtime pushes a synthetic tool call (`defer_defect` by default; `release_aircraft` and `extend_crew_fdp` are allowed) **through the real tier gate**, attributed to the maintenance agent and flagged `presenterTriggered: true`. It gets exactly the same `guardrail.blocked` event and safety-gate counting as a real attempt. The KPI "why" should say that the attempt was presenter-triggered.
- The UI renders the refusal as a **visible card in the agent stream**, "Blocked by autonomy policy", showing the tool, reason, rule, and who holds the authority (for example "Certifying staff"), not only as a log event.

### 1.4 Swap approval wording
In the swap approval card, the primary action label becomes **"Send swap request to OCC"**. The body wording makes it clear that approving **sends a request** to OCC and doesn't execute the swap (for example "Approving sends this swap request to Operations Control; OCC confirms and executes."). Check that `propose_swap`'s result and the `occ` state reflect it: approval leads to `SwapDecision.status = 'requested'`, and OCC confirms through a modelled process (`occ.tick`).

### 1.5 Recommendation cards show provenance and scope
Every recommendation or decision card (proposals, `request_decision` options, agent report recommendations) displays four things:
- **sources**: citations with a one-click quote
- **timestamps**: sim time created, data as-of time
- **unresolved checks**: a list of what hasn't been verified yet
- **approval scope**: exactly what approving authorises, and what it doesn't

Add optional fields `unresolvedChecks: string[]`, `approvalScope: {authorises: string, doesNotAuthorise: string[]}`, `citations` and `dataAsOfMinute` to `agent.proposal`, `DecisionOption` and `AgentReport` recommendations. The runtime fills `dataAsOfMinute`. Role prompts ask for the other fields, and the runtime supplies safe defaults: the scope comes from the tool definition. Add an `approvalScope` string to each propose-tier `ToolDefinition`.

### 1.6 Missing maintenance data → "Unknown"
When a maintenance record or field is missing (for example a last-check date, a defect history or a work-order status), the context pack, tool results and UI show **"Unknown"**. **Never default to passed, OK or serviceable.** Audit `mne` seeds, the tool results and the UI renderers. Add tests with a scenario fixture that omits maintenance fields.

### 1.7 Approval invalidation on the engineer-ETA twist
- Proposals record the `assumptions: {key, value, source}[]` they depend on (for example `engineerEtaMinute`).
- When a twist, or any mutation, changes an assumption of an **already approved** decision, the runtime emits an additive event `approval.invalidated {approvalId, affectedAssumptions: {key, was, now}[]}`. It then delegates to the owning agent to re-gather evidence, which appears as normal tool calls, and to issue a **revised proposal** linked by `supersedesApprovalId`.
- Add an engineer-ETA twist (`engineer ETA +40 min`) to the relevant scenarios: at least s01 and s04. It must fire after the first approval.
- The UI shows an **"Approval invalidated"** notice listing the affected assumptions (was → now), then the re-gathered evidence cards, then the revised proposal.

### 1.8 Labels
- A persistent **"Simulated systems"** badge. It already exists; verify it is visible on every screen, including side-by-side and the PDF.
- The baseline panel is titled **"Illustrative manual workflow"**.
- The cost and customer KPI tiles get the suffix **"(estimate)"**.
- The safety and compliance tiles render as **check status**: a ✓ / ✗ / pending list, not numeric scores.

### 1.9 Idempotent notifications and work orders
Add a required `requestId` (a client-generated UUID) to the notification and work-order tools: `create_work_order`, `page_engineer`, `notify_handler`, `send_passenger_message`, and any other tool that notifies. The system dedupes on it: a repeat `requestId` returns the original result with no new mutation. Add tests for retries.

### 1.10 Private names only from the local brand pack
- The public tree must contain **no client or consultancy names**. The terms are listed in the git-ignored `config/private-words.txt`; read that file and grep the tree and history for them (case-insensitive).
- Remove every occurrence. The UI may show those identities **only** when they are loaded at runtime from `config/brand.local.json`, which is git-ignored.
- `npm run hygiene` must pass with the word list present.
- **Never write those names into any committed file, commit message or report.** Refer to them as "the private names".

### 1.11 Plain-language glossary and toggle
- Add `apps/web/src/glossary/glossary.json`, keyed by term, with a one-line plain-English definition for each entry. Use exactly these definitions:
  - **MEL:** the list of items an aircraft may fly with unserviceable, and under what conditions
  - **Deferral:** recording a defect as acceptable to fly with for a limited time, under the MEL
  - **AOG:** aircraft on ground: not flyable until fixed
  - **Tow-bar / pushback:** the bar connecting the tug to the nose wheel when the aircraft is pushed back from the stand
  - **Stand / gate:** the parking position; a gate has a bridge or door to the terminal
  - **Rotation:** the sequence of flights one aircraft is scheduled to fly today
  - **Sector:** one flight from departure to arrival
  - **Reactionary / knock-on delay:** delay to later flights caused by this one
  - **FDP / duty margin:** the legal working hours remaining for the crew
  - **Commander's discretion:** the captain's limited power to extend crew hours in specific circumstances
  - **OCC / ICC:** the airline's operations control centre
  - **MCC:** maintenance control, the engineers who decide technical questions
  - **Certifying staff:** licensed engineers who may release an aircraft to fly
  - **Occurrence report (MOR):** the mandatory safety report filed after an incident
  - **EU261 / UK261:** the passenger-compensation rules for delays and cancellations
  - **PRM:** passengers needing assistance
  - **Ground handler:** the contractor providing stairs, buses, loading and pushback
  - Each entry has `{definition, inline, aliases[]}`, where `inline` is the short replacement phrase used in plain-language mode (for example Deferral → "fly with the defect for a limited time").
- Add a shared **`<Term>`** component: a Radix Tooltip that is keyboard-accessible (opens on focus), has a **300 ms delay**, and shows the one-line definition. Apply it wherever these terms appear in labels, cards, tiles and the agent stream. For free text such as agent thoughts, tool results and messages, add a `<GlossaryText>` that auto-wraps alias matches (whole-word, case-insensitive, first occurrence per block).
- A **"Plain language"** toggle in the command palette, persisted in localStorage with a try/catch. When it's on, every `<Term>` and `<GlossaryText>` match renders its `inline` replacement instead of the term; the tooltip still shows the original term. **This must work reliably:** add component tests and extend the Playwright smoke test to toggle it and assert a replaced phrase.
- Add Storybook stories for `Term` and `GlossaryText` (the plain-language toggle on and off).

## 2. Definition of done
- [ ] Every item from 1.1 to 1.11 is implemented, with tests where they apply (runtime, tools and UI).
- [ ] `npm run typecheck && npm run lint && npm run lint:headers && npm test && npm run synth` all pass. `npm run build -w @ica/web`, the Storybook build and the Playwright smoke test pass. The `replay` and `baseline` eval tiers pass or are reported honestly. **No `--live` evals, no live LLM calls, no AWS calls, no push.**
- [ ] `npm run hygiene` passes with `config/private-words.txt` present.
- [ ] Mock-mode fixtures in `apps/web` are updated so every new UI element is demonstrable without a backend: invalidation, the blocked-action card, provisional reading, Decided-by, provenance on cards and the glossary toggle.
- [ ] The final report lists each item with the files changed and any contract additions.
