# Task 08 — Agents view: per-agent observability (UI only)

> **Scope: UI/UX only.** No changes to the runtime, API, events or infra. Everything is derived from the existing run event log in the browser. The dashboard's Agent Activity panel keeps its feed and filters. It only gains three things: name tooltips on its code chips, an expand action that opens this view, and **`headline()` for its card title line** in place of the model's text, which is a one-line change.

## Goal
What the agents do is the critical part of this product. Give the duty manager a clear, per-agent account of the incident: who did what, in what order, why, what they knew when they did it, and where a person decided. Everything is in plain language.

## Navigation
- Top nav: **Network · Agents · Training scenarios · Evals**.
- The route is `/runs/:runId/agents`. The "Agents" nav item opens the Agents view of the run currently open. When no run is open it is disabled, with the tooltip "Open an incident first".
- The **expand** action on the dashboard's Agent Activity panel opens this view. The panel itself, its feed and its filters are unchanged.
- The dashboard panel's code chips get a tooltip with the full agent name, via the same `roles.json`.

## Roles data: `apps/web/src/agents/roles.json`
Shape: `{ role: { displayName, abbrev?, objective } }`, editable without touching components:

| Role | displayName | abbrev | objective |
|---|---|---|---|
| orchestrator | Orchestrator | — | Runs the incident: sets the goal, briefs the specialists, brings their answers together, asks a person when a decision needs authority. |
| maintenance | Maintenance | MX | Finds out what is wrong with the aircraft and what it would take to fix it; hands the airworthiness decision to certifying staff. |
| ground | Ground | — | Arranges the stand, stairs, buses, towing and the ground handler's tasks. |
| flightops | Flight Operations | — | Works out the knock-on effect on today's flights and crew, and finds options: swap, delay, cancel. |
| passenger | Passengers | PX | Keeps passengers informed and looked after; prepares messages, care and rebooking for approval. |
| record | Incident Record | — | Keeps the timeline, decisions and evidence; drafts the reports that must be filed afterwards. |
| author | Scenario Author | — | Turns a description of what's happening into the scenario the team works on. (Banner only; see Layout.) |

In the Agents view, always use `displayName` (with `abbrev` in brackets where one exists). Never use the codes OR, GR, FO or RC; FO means First Officer in aviation.

## Layout
- A slim **timeline bar** at the top: sim clock, scrubber, play/pause, **Back to live** and the **Hide thoughts** toggle. Hide thoughts is the only filter, and it is persisted per viewer.
- A **Scenario Author banner** appears only if authoring happened: one line ("Scenario enriched from your description" or the fallback notice), and it expands to show the author's rows.
- **Columns:** up to six, equal width, one per agent that has at least one action, ordered by first activity. They scroll horizontally below 1400 px.
- **Column header:** full name (abbrev), a one-line objective, a status dot and the turn count.
  - Status: **working** (mid-turn), **waiting** (held on a human approval), **blocked** (stopped by a limit or an error), **done** (reported).
  - Refused calls do not change the status; they appear as rows.
- **Column body:** one row per action, oldest at top. It auto-scrolls to the newest unless the viewer has scrolled up ("Jump to latest" chip). Virtualised, so long runs stay smooth.

## Rows
- **Turn tag** `T{iteration+1}`. Parallel calls in one turn share the tag.
- **Sim time** (`m4`).
- **Type icon:** thought, tool call, proposal, **waiting**, **decision**, blocked, **stopped**, report.
- **Plain-language headline.**
- **Tier badge** where it applies: Executed, Proposed or Blocked.

**Human decisions and stops are rows of their own.** They are the most important moments in a column, so they are never hidden inside an expanded proposal:
- **Waiting row:** when an agent proposes and blocks, the next row is "Waiting for a decision: {plain summary}". It is live while pending, with the pending approval's scope and a link to the decision rail.
- **Decision row:** when the human decides, a row reads "Approved by {roleTitle} at m{t}", "Approved with edits by…" or "Rejected by… — {reason}", attributed from `approval.decision.decidedBy`. It has its own icon and tier colour. Policy decisions (baseline or eval) say so.
- **Invalidation row:** "Approval withdrawn: {assumption} changed ({was} → {now})" from `approval.invalidated`.
- **Terminal stop row:** plain words with its own icon, from `agent.aborted`. For example, "Stopped: reached the 60 tool-call limit for this agent", "Stopped: 25 steps without finishing", "Stopped: run time limit", or "Stopped: error — {short reason}". This is distinct from a single refused call, which is a Blocked row.

**Headlines are generated in code**, never from model text: `headline(tool, args, result)` with one template per tool. That is all 54 tools (49 domain + 5 runtime), for example:
- `page_engineer` → "Paged the duty engineer at {station} — ETA {eta} min"
- `find_spare_aircraft` → "Looked for a spare aircraft at {station} — {found ? 'found ' + tail : 'none available'}"
- `append_timeline` → "Logged to the incident record: {text, clipped}"
- `draft_passenger_message` → "Drafted a passenger message ({channel})"
- `delegate` → "→ briefed {Role displayName}"; the child's first row reads "← brief from Orchestrator"
- `report` → "Finished — {openIssues.length} open issues"
- The fallback is "Called {plain tool label}", taken from a label map; raw names are never shown.

**Length:** every rendered headline must be **60 characters or fewer**, so at about 300 px per column on a 1080p projector it wraps to two lines at most. Templates clip free text with an ellipsis, and a test enforces the limit on every template with realistic long arguments. Human-meaningful identifiers (flight number, tail, station, stand, cohort name) are allowed. **Internal identifiers** (work-order, engineer, request and tool-call ids, `toolu_…`) and tool or parameter names are **never** shown, and a unit test enforces this across all templates and fixtures. Thought rows show a neutral headline ("Reasoned about next steps"); the model's text appears only when the row is expanded, labelled "AI reasoning (unverified)".

## Expanded row (in place, one at a time per column)
1. **Facts gathered by this turn:** the agent's brief plus the results of its own earlier tool calls up to this turn, as compact fact cards. The orchestrator's view also includes the specialists' reports received so far. This is **derived from the event log**, and it is **not** the exact messages array the model saw, which exists only in the S3 trace. The heading says exactly that, and a small info tooltip explains: "Reconstructed from the run's events; the model's full context is in the trace." Never label it "What it knew".
2. **What it decided:** the action in plain words, plus the AI reasoning for that turn if present (labelled).
3. **Detail:**
   - Tool calls: arguments and result, rendered with `ArgValue`.
   - Proposals: payload, approval scope and the human decision (who and when).
   - Blocked: the guardrail reason, the rule and who holds the authority.
   - Reports: structured content (summary, actions, open issues, recommendations, citations, provisional reading, screening flags).

## Delegation links
Clicking "→ briefed X" scrolls X's column to its "← brief from Orchestrator" row and highlights it, and vice versa. Pairing uses `parentAgentRunId` and the delegate call.

## Time sync
Selecting a row moves the shared scrubber to that row's sim time, which puts the dashboard into history mode at that moment. The timeline bar shows "Viewing m42 — Back to live".

## Quality
- **Keyboard:** arrows move between rows and columns, Enter expands, Escape collapses, `[`/`]` switch columns. Columns are lists with a live region for new rows. Focus is managed when rows expand. Meets WCAG 2.2 AA.
- **Mock mode** shows every row type (including delegation links, blocked, proposal with decision, report with flags, and the author banner).
- **Storybook:** column, row (each type, collapsed and expanded) and header (each status), in empty, loading, live and error states, with axe clean.
- **Tests:**
  - a headline template exists for every tool in the registry (the test fails when a new tool lacks one);
  - no internal IDs or tool names appear in headlines;
  - every headline is 60 characters or fewer;
  - the waiting, decision, invalidation and stop rows are derived correctly;
  - delegation pairing, time-sync dispatch and Hide thoughts work;
  - the dashboard panel's card titles use `headline()`.
- **Playwright:** open a run, go to Agents, see a waiting row and then its decision row, expand a row, follow a delegation link, check the scrubber moved, then Back to live.

## Definition of done
All the above; every check passes (typecheck, lint, headers, tests, web build, Storybook, Playwright, hygiene); no backend changes; merged, deployed (web stack only) and pushed.
