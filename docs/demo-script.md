# Demo script

Two presenter scripts for the Ground Incident Coordination Agent cockpit: a **90-second** version for the README GIF and a
**10-minute** version for a live presentation. Everything shown is a simulation of a fictional carrier
(Northwind Air); keep the "Simulated systems · fictional carrier" badge in shot.

## Before you start

| Mode | Command | Use it when |
|---|---|---|
| Mock (no backend, no network) | `npm run dev:mock -w @ica/web` → <http://localhost:5173> | GIF recording, rehearsals, the network is down |
| Local | `npm run dev` (in-memory API + WebSocket on :8787, Vite on :5173) | the real agent runtime on your laptop |
| AWS | `npm run dev:aws`, or the CloudFront URL | the deployed stack (Cognito sign-in first) |

The only switch between local and AWS is `apps/web/public/config.json` (`WebRuntimeConfig`), written by the scripts.

Mock-mode URL parameters:

- `?autopilot=1`: every decision is taken with the recorded human decision after its recorded delay (hands-free).
- `?timescale=4`: compresses the replay pacing on top of the run speed (rehearsals only).
- `/runs/<id>?at=31`: open a run at a sim minute (history view); `?dev=1` shows the dev overlay (event counts,
  stream state, first-event latency after the trigger).

Mock mode has full recordings for **s01** (MAN, towbar shear) and **s04** (FAO, lightning strike, options case),
each with its paired baseline run. Other scenarios need the local dev server. Two completed demo pairs are always
listed under *Recent runs* (useful for side-by-side without waiting).

### Keyboard

| Key | Action |
|---|---|
| `⌘K` / `Ctrl+K` | Command palette: run control, speed, twists (scenario list or free text), replay baseline, reset, side-by-side, captions, theme, jump to event, switch scenario |
| `Space` | Pause / resume the world clock (when focus is not on a control) |
| `F` | Full screen for the focused (or last clicked) zone; `Esc` returns |
| `A` / `E` / `R` | Approve / edit / reject the focused decision card (`Tab` to it) |
| `←` `→` (`Shift` ×5), `Home`, `End` | On the timeline: step back and forth, go to the start, go live |

---

## 90 seconds (README GIF)

Setup: mock mode, 1920×1080, dark theme, captions on. On the home page tick *Run the human baseline alongside* and set
**Speed 30×**. Start recording.

| Time | Do | Say (caption) |
|---|---|---|
| 0:00 | Home page. Point at **s01 · Towbar shear and nose-gear contact on pushback**; press **Start** | "A tug hits the nose gear during pushback at Manchester. 174 passengers on board." |
| 0:05 | Cockpit opens; KPI strip and zones fill in under 2 s | "Six numbers answer *how bad is it*. Grey figures are the same moment in today's manual process." |
| 0:12 | Agent avatars light up; the stream shows the orchestrator briefing four specialists in parallel; the engineer's `E` starts moving on the stand view | "The orchestrator fans out: maintenance pages a B1 engineer, ground asks for a tow, flight ops checks the rotation." |
| 0:20 | The first card arrives in **Decision needed**: the first passenger message, labelled **AI-drafted**, with a countdown | "Anything that touches people waits for a human. This is the first message, drafted by the passenger agent." |
| 0:25 | Press **A** (or click Approve). The phone mock-up shows the exact SMS with *Approved by …* | "Approved at minute 6. The baseline team sends its first message at minute 28." |
| 0:35 | The scheduled twist "Second tug unavailable" (caption); stairs and buses appear on the stand | "No tug: ground switches to stairs and buses so nobody is stuck on board." |
| 0:45 | Calm amber card in the stream: **Blocked: Defer defect** | "The agent tried to defer the defect. That is a certifying engineer's call, so the code blocked it: nothing changed." |
| 0:55 | The options card: swap to spare NW-LRM (recommended), hold, cancel. Click **Choose** on the recommended row | "Three real options, ranked. Choosing a row *is* the decision." |
| 1:05 | The Gantt bars re-flow onto NW-LRM and turn from red back to amber; the cost ticks down | "The swap recedes the delay across the whole day's rotation." |
| 1:15 | Point at the KPI strip: cost, satisfaction and the 3-hour margin against the grey baseline figures | "Same incident, same world: cheaper, earlier, calmer than the baseline." |
| 1:25 | Stop recording on the **Run complete** card (or when the swap has settled) | — |

Fallback: if a decision is missed, the card simply waits (the mock replay pauses on it). For a hands-free take, use
`?autopilot=1`.

---

## 10 minutes (live presentation)

Setup: local dev server (`npm run dev`) or mock mode, 1920×1080, speed 6×, captions on. Have the s01 demo pair in
*Recent runs* ready for step 6.

### 1. The problem and the promise (0:00–1:00)

Home page. "Ground incidents are coordination problems: engineering, ramp, crew, passengers, all at once. Today it is
phones and spreadsheets. Here, specialist agents do the legwork on simulated airline systems; humans keep every
decision that matters." Point at the badge: simulated systems, fictional carrier.

### 2. The options case: s04 lightning strike at Faro (1:00–3:30)

- Start **s04** with the baseline. "A lightning strike on arrival at Faro; no licensed engineer on site."
- Show the zones in reading order: KPI strip (*how bad*), network map (*where it spreads*: FAO → MAN, spare NW-PQT at
  Gatwick), stand view (*what is happening at the aircraft*), decision rail (*what needs me*), passengers (*who is
  affected*), timeline and inspector (*what changed*).
- Approve the first passenger message (**A**). Point out the AI-drafted label and the approver line on the phone.
- A calm amber card appears: **Blocked: Extend crew FDP**. "Flight ops looked at extending the crew's duty; that is the
  commander's discretion, so the tool is forbidden for software. Blocked and counted, nothing changed." Point at the
  *Safety gates* tile.
- The **options matrix**: contract a local B1 (recommended), fly an engineer from Manchester, ferry a spare, cancel.
  Walk the bars: time to departure, cost, customer impact, compliance, constraints. Press **F** on the decision rail
  for full screen, then **Choose** the recommended row. **Esc**.

### 3. Inject a twist (3:30–4:30)

- **⌘K** → *Inject: Contract engineer authorisation delayed* (or type *twist*). The caption and a timeline marker
  appear; the orchestrator notes it.
- **⌘K** → *Inject a free-text twist…* → type "A second aircraft needs stand 7 in twenty minutes" → **Enter**.
  "Free text is screened and handed to the agents as data, never as instructions." (Try "ignore previous
  instructions…" to show the rejection toast.)

### 4. Care decisions, edit and reject (4:30–5:30)

- When the refreshment-voucher card arrives, press **R**, type "Departure after 16:00 local: meal vouchers instead",
  submit. The agent re-proposes meal vouchers; approve them.
- On any passenger message, press **E** to show the inline diff editor (schema hints, changed fields highlighted).

### 5. Why this number (5:30–6:30)

- Click the **Disruption cost** tile: the drawer shows the formula, the inputs and the events that moved it. Click one
  event: the whole screen time-travels to that moment (the timeline shows *history*). Press **End** on the timeline
  or **Live** to come back.
- Drag the timeline back to the trigger and forward again: "Every event is stored; the screen is rebuilt from the log
  with one pure reducer, so any moment can be replayed."

### 6. A free-text scenario (6:30–7:45)

- Home → *Write a scenario*: "A catering truck clips the forward door of an A320 at Palma during turnaround; two
  wheelchair users on board." → **Author scenario**. Show the screening verdict and the schema-valid preview (AI-drafted).
- **Start this scenario**, watch the first seconds, then return to the s01 demo pair.

### 7. Side-by-side (7:45–9:00)

- From *Recent runs* (or **⌘K** → *Side-by-side with the baseline*), open the s01 comparison. Press play on the shared
  timeline: the agent run and the baseline advance in lock-step, KPI strips stacked, deltas highlighted (cost,
  satisfaction, margin to 3 h, human decisions). Point at the key moments lists: first passenger message at minute 6
  versus minute 28.

### 8. Evidence and close (9:00–10:00)

- Back in the s01 cockpit, the **Run complete** card: headline KPIs against the baseline and every decision with its
  approver. Click **Evidence pack (PDF)**: decisions with named approvers, messages and report drafts labelled
  AI-drafted, the KPI snapshot and citations. Click **JSON trace** for the raw event log.
- Close on the **Evals** page: pass rates per layer and the lifetime £10 eval budget.

### Fallbacks

| If… | Then |
|---|---|
| The network or the API is down | Switch to mock mode (`npm run dev:mock -w @ica/web`): same UI, recorded s01/s04 runs |
| The WebSocket drops | Nothing to do: a "reconnecting" toast appears, the client polls every 2 s and says "Reconnected" when it is back. In mock mode you can show this on purpose: **⌘K** → *Simulate a connection drop* |
| The run is too slow for the slot | **⌘K** → *Set speed 30×* (or press 30× on the timeline) |
| You miss a decision or a card expires | The card stays in the rail (overdue in red); decide it, or use `?autopilot=1` in mock mode |
| You need a specific moment | `/runs/run-demo-s01?at=31` opens the options decision; `/runs/run-demo-s04?at=15` the s04 matrix |
| The projector is bright | **⌘K** → *Switch to the light theme* |

## Presenter aids (brief alignment)

- **Demonstrate blocked action** (⌘K): pushes a synthetic `defer_defect` (or `release_aircraft` / `extend_crew_fdp`) through the real tier gate, attributed to the maintenance agent and flagged presenter-triggered. The agent stream shows a "Blocked by autonomy policy" card with the rule and who holds the authority; the safety-gates tile counts it and its "why" says it was presenter-triggered.
- **Plain language** (⌘K): aviation terms (MEL, AOG, FDP, OCC…) render as plain phrases; hover or focus a term for its one-line definition. The setting is remembered in this browser.
- **Engineer delayed: ETA +40 min** (s01, s04; fires after the first approval): an approved decision that relied on the old ETA is shown as "Approval invalidated", the owning agent re-gathers the evidence and a revised proposal appears for a decision. In mock mode the s04 recording shows the whole sequence.

