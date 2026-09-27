# Task 05 — Web front end & design system

> Runs in parallel with 02, 03 and 04, after task 01 has been committed. Work on branch `task/05-web`. **"The UI is the product"** (spec §4): this task is judged on clarity, calm and craft as much as on function.

## 0. Read first

- `CLAUDE.md`: the standing rules.
- `docs/specification.md`: **§4 in full** (design principles, layout, every zone, side-by-side, states, event consumption, design-system deliverables), §5 (API and WebSocket), §8 (KPIs, to explain them in "why this number"), and §11 (trust cues: AI-drafted labels, tier and approver on every action, provenance).
- `packages/schema/CONTRACTS.md`: `RunEvent` and its payloads, `applyEvent`/`RunProjection` (use the shared reducer; don't write a second one), `KpiSnapshot`, `DecisionOption`, the `SystemState` entity types, `SYSTEM_ENTITIES`, `api.ts` (`AppConfig`, `WebRuntimeConfig`, the route types) and `packages/schema/fixtures/run.sample.events.json`.

## 1. You own

```
apps/web/              React 18 + TS + Vite SPA, Storybook
packages/ui-tokens/    design tokens (CSS variables, light + dark), Tailwind preset, Figma/Tokens-Studio JSON export
docs/demo-script.md    presenter script (90-second and 10-minute versions)
```

**Do not edit** `services/**`, `infra/**` or `packages/schema|store` (additive only, and report it). Develop against:
1. **Mock mode** (`VITE_MOCK=1`): an in-browser fake backend that serves `/config`, `/scenarios` and a run whose events are **replayed from fixtures** at the chosen speed, including pending proposals that the UI can decide, which the fake then follows up. Build a richer fixture of your own (`apps/web/src/mocks/fixtures/*.events.json`, about 300 events covering every zone: an options matrix, a twist, passenger messages, a baseline pair) and **validate it against the schema in a test**.
2. `npm run dev`: the local dev server from task 04, once it's merged. The API client must work unchanged against mock mode, local and AWS.

## 2. Stack (decided, spec §4)

React 18, TypeScript, Vite, **Radix primitives + Tailwind** driven by `@ica/ui-tokens`, **Framer Motion** (150–300 ms, `prefers-reduced-motion` respected via `MotionConfig`), **SVG** for the map, Gantt and stand views, **visx** for sparklines, **Zustand** for the store, React Router, and `oidc-client-ts` for Cognito hosted UI with **PKCE**. Also `cmdk` for the ⌘K palette, and `@react-pdf/renderer` (or `pdf-lib`) for the **PDF evidence pack**. There is no server rendering.

## 3. Data layer

- `config.ts` fetches `/config.json` (`WebRuntimeConfig`) at boot, then `GET /config` (`AppConfig`, the brand pack). The brand pack sets the carrier name, logo, colour pair (mapped onto the token accent variables) and the station list. If it's missing, fall back to the bundled Northwind Air defaults (FR-11).
- `auth.ts`: `mode:'none'` → no login. `mode:'cognito'` → an oidc-client-ts code flow with PKCE, silent renew, the access token attached to fetch, `token=` on the WebSocket URL, and logout.
- `api.ts`: a typed client for every route in `api.ts`, with retries and backoff on network errors only.
- `runStream.ts` implements the **event consumption algorithm exactly as in spec §4**:
  1. Hydrate with `GET /runs/{id}/events?after=0`, paging until `hasMore=false`.
  2. Open the WebSocket.
  3. Apply events by increasing `seq`, dropping duplicates. A gap triggers a re-fetch from the last contiguous seq.
  4. On WS drop, show a "reconnecting" toast and **poll `GET …/events?after=` every 2 s** until the WS reconnects (with backoff).
  5. On reconnect, show a toast.
  - Unit-test duplicates, gaps, out-of-order batches and reconnects.
- **Store (Zustand):** `events: RunEvent[]` (the full array), `projection = fold(applyEvent)` at the head, and a `cursorSeq` for the scrubber. **At any seq, `selectAt(seq)` rebuilds the projection with the pure shared reducer.** Memoise with checkpoints every 200 events so scrubbing a 5,000-event run stays at 60 fps. For the paired baseline run, keep a second stream, aligned on `simMinute`.
- **Optimistic approvals:** mark the card as "decided (sending…)" immediately. Reconcile when the `approval.decision` event arrives, and roll back with an error toast if the POST fails.

## 4. Screens and zones (spec §4 layout: 12-column grid, 1920×1080 and ultra-wide, degrading to laptop ≥ 1280 px)

- **Run cockpit** (`/runs/:id`):
  - Row 1: the KPI strip.
  - Row 2: Network view (5 columns), Ground view (4), Decision rail plus Agent activity (3).
  - Row 3: Passenger view (7), then the Timeline scrubber and System inspector tabs (5).
  - `F` expands the focused zone to full screen, `⌘K` opens the palette, and `Space` pauses or resumes the world clock (`POST /runs/{id}/control`).
- **Home** (`/`): the scenario picker (library cards with station, aircraft type and "inspired by" provenance), an AuthorBox (free text → `POST /scenarios/author` → preview the validated scenario and any screening findings → start), recent runs, and the latest eval summary (`GET /evals/latest`).
- **Side-by-side** (`/compare/:agentRunId/:baselineRunId`): the two runs in lock-step on one timeline, with the KPI strips stacked and the deltas highlighted (FR-08).
- **Eval report** (`/evals`): the latest report rendered with pass rates per layer, judge scores, deltas, and the lifetime eval spend vs. the £10 cap, read from the report's ledger summary.

Every component, as named in the spec. Build each one from real contract data:

| Zone | Components | Key behaviours |
|---|---|---|
| KPI strip | `KpiStrip`, `KpiTile`, `WhyDrawer` | Six tiles: incident clock, countdown to 3 h, cost meter (€, ticking with animated tabular numerals), satisfaction gauge, compliance checklist, safety gates. Each shows the value, a **baseline ghost delta** (small grey figure, from the paired run when present) and a 60-second visx sparkline. **Colour only when a threshold is crossed.** Clicking opens `WhyDrawer`: `formula`, `inputs` and `contributingSeqs` as links that move the scrubber to those events |
| Decision rail | `DecisionQueue`, `DecisionCard`, `DiffEditor` | Pinned top-right, labelled "Decision needed", most urgent first, with a countdown (from `expiresAtMinute`, else age). A plain-language summary; expand for the agent's reasoning. Approve / Edit (an inline JSON diff editor of `args` → `editedArgs`, schema-hinted) / Reject (a required reason). Keyboard A/E/R on the focused card. A live-region announcement for each new decision. Shows tier and requesting agent; after a decision, the approver's name and role |
| Alternatives | `OptionsMatrix` | When a proposal has `options`: a ranked matrix (time to departure, cost, customer impact, compliance, constraints) with bar-in-cell encoding and the recommended row highlighted. Selecting a row = approve with `selectedOptionId` |
| Network | `NetworkMap`, `RotationGantt` | An **equal-area** projection (for example d3-geo `geoConicEqualArea` fitted to the stations) of the stations from `AppConfig.stations`, with the affected tail and spare candidates (from `occ` state). The Gantt shows the tail's rotation; amber and red propagate along the line with delays and **recede when a swap is approved** (animated re-flow). Hovering shows knock-on minutes per sector |
| Ground | `StandView` | A top-down SVG stand: aircraft silhouette, tug, GSE, the engineer's avatar moving along an ETA path (from `engineers` state and `world.process` events), a spare on the adjacent stand, and stairs and bus icons appearing when confirmed |
| Agent activity | `AgentStream`, `ToolCallCard`, `AgentAvatarRow` | One collapsible stream per role, interleaved by time. Each card shows the thought summary (one line), the tool name and args, a result preview, a **tier badge**, latency and a citations chip. Expand for the full thought, args and raw result. Avatars light up while their agent is working (between `agent.started` and `agent.report`). Filter by role or event type. `guardrail.blocked` renders as a distinct, calm warning card |
| Passenger | `CohortBoard`, `PhoneMock`, `CommsLog` | Cohort cards (connections, PRM, families, UM) with status. A phone mock-up renders the exact message sent, **labelled "AI-drafted"**, with the approver. The comms log has timestamps |
| Timeline | `TimeScrubber`, `EventMarkers` | Markers for trigger, decisions, messages, twists and baseline milestones. Drag to time-travel (the whole screen reconstructs), play and pause, a speed control, and "Live" to rejoin the head |
| Inspector | `SystemTabs`, `EntityTable` | A tab per system (`SYSTEM_ENTITIES`), with live tables and a **change highlight on rows touched by the latest mutation** |
| Captions | `Narrator` | Optional one-line captions generated **client-side from templates over events** ("Engineer paged — ETA 9 min"). No LLM. Toggle in the palette |
| Presenter | `CommandPalette`, `ScenarioPicker`, `AuthorBox` | Pick or write a scenario, trigger, inject a twist (scenario twist list or free text), replay the baseline (starts a paired baseline run), reset (new run of the same scenario), toggle side-by-side, toggle captions, jump to an event, switch theme |

Global elements:
- An always-visible **"Simulated systems · fictional carrier"** badge.
- Skeletons on load, and toasts for reconnect and errors.
- A **"Run ended" summary card**: the headline KPIs vs. the baseline, the decisions taken, and exports for the **PDF evidence pack** (rendered client-side from the `record` state's `EvidencePack` plus decisions with approvers, messages, report drafts, KPI snapshot and citations; every AI-drafted section labelled) and the **JSON trace** (`GET /runs/{id}/export`).

## 5. Design system (`packages/ui-tokens`)

- Tokens as CSS variables with **dark (the default, "ops room") and light** values: colour (neutrals plus **exactly four accents: good, warning, critical, AI**), type scale (tabular numerals for all figures), an 8-pt spacing grid, radii, elevation, and motion (durations 150/200/300 ms and easings).
- Exports: `tokens.css`, a Tailwind preset, a TS constants object, and a **`figma-tokens.json` in Tokens Studio format**. This satisfies the spec's "Figma file mirroring the tokens": contributors import it into Figma with the Tokens Studio plugin. Document that in `packages/ui-tokens/README.md`.
- **WCAG 2.2 AA:** add an automated contrast test over every foreground and background token pair in both themes.

## 6. Quality bars

- **Storybook** (`npm run storybook`): **every component** in the four states (**empty, loading, live, error**) with fixture-driven stories. Add the a11y addon, and run it with no violations on the main components.
- **Accessibility:** full keyboard operation (a visible focus ring, a logical tab order, focus trapping and return on drawers and the palette), live regions for new decisions and the "Run ended" card, and reduced-motion support.
- **Tests:** Vitest plus Testing Library for the store, reducer integration, runStream and the key components (the DecisionCard flows, the OptionsMatrix selection, and a WhyDrawer seq link moving the scrubber). Add **one Playwright smoke test** in mock mode: load, start a run, approve a decision, scrub back, and check the KPI changes.
- **Performance:** first meaningful paint under 2 s on a local build; the first event appears under 2 s after the trigger (FR-02, measured in mock mode with a live timestamp in the dev overlay); a code-split cockpit route; bundle-size budget warnings.
- **Visual quality:** calm density, one question per zone, and no log-viewer walls of text. Check yourself against the spec §4 principles table before finishing. Use the browser tools to take screenshots of the cockpit at 1920×1080 and 1440×900 in both themes, and fix anything cluttered.

## 7. `docs/demo-script.md`

Two scripts. **90 seconds** for the README GIF: s01, trigger, agents fan out, first passenger message, approve a swap, KPI vs. baseline ghost. **10 minutes** for a live presentation: s04 options case, a twist injection, a free-text authored scenario, side-by-side, the "why this number" drawer, a blocked forbidden action, and the evidence-pack export. Include keyboard shortcuts and fallback steps (mock mode if the network is down).

## 8. Definition of done

- [ ] `npm run build -w @ica/web` (typecheck plus Vite), `npm test -w @ica/web -w @ica/ui-tokens` and the Playwright smoke test all pass.
- [ ] Mock mode demonstrates every zone and flow from §4, including side-by-side, the scrubber, the options matrix and the PDF export.
- [ ] The Storybook builds (`storybook build`), with every component in its four states and a11y checks passing.
- [ ] The token contrast test passes in both themes; `figma-tokens.json` is exported.
- [ ] Works against `npm run dev` (task 04's local server) once it's merged; the only config switch is `config.json`.
- [ ] Final report: screenshots (saved to `docs/screenshots/`, fictional data only), contract changes, known gaps.
