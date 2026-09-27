# Task 07 — Live network home, flight-first incident reporting, airborne incidents

> Runs **after** the `feat/hybrid-search` and `fix/live-run-1` branches are merged into `main`. Phase 0 (rebrand) runs first, then two phases:
> - **Phase A** (domain, one agent) must be committed before **Phase B** (web, one agent) starts, because B consumes A's `@ica/network` package.
> - Both phases stay within the rules in `CLAUDE.md`. Contract changes are additive and logged in `packages/schema/CONTRACTS.md` §11.

## Delivery order (owner priority, 2026-09-27)

The owner wants the **flight-map home first**: open the app, see the live network, pick a flight, then report an incident from a **simple list** plus a **free-text option**. Deliver in milestones and **commit at the end of each one, with everything green**, so the home can be deployed before the airborne depth lands:

- **M0:** Phase 0, the Accent Air rebrand.
- **M1:** `@ica/network` (the schedule, `flightStateAt` and `suitableAirports`), plus the web home as a live map with the flight list and flight panel. The home route `/` becomes the network view. The library becomes "Training scenarios", a secondary route or tab reachable from the nav.
- **M2:** "Report incident" from the flight panel. It is a **simple list** of incident types applicable to the flight's phase, each with a one-line plain-language description, plus a **free-text box** ("Describe what's happening"). Picking a type starts immediately: the server builds the scenario with the templates from the flight context. Free text runs the Scenario Author seeded with the flight context. No multi-step wizard. Show a short preview line and a Start button. The ground incident types come first, using the existing ten scenario families as templates; the airborne types may show as "coming soon" until M3.
  - This includes the API flight-context `POST /runs`, and mock mode working end to end.
- **M3:** the airborne systems, tools, tiers and roles; the five airborne types in the list; the airborne scenarios, KPIs, evals and glossary; the cockpit airborne visuals.

## Owner decisions (2026-09-27)

1. **Scope widens from ground/pre-departure to ground + airborne incidents**: air turnback, diversion, medical diversion, smoke/fumes, pressurisation, engine shutdown.
   - The agents coordinate the **ground-side response**: OCC options, maintenance at the arrival or diversion station, handling, passengers, crew FDP and reporting.
   - **The commander flies and decides the aircraft.** Any tool that would instruct the flight deck (routing, altitude, whether to divert, choice of airport, landing overweight or not) is **forbidden** in code.
   - Agents may only **prepare options** (a suitability ranking of diversion airports) and coordinate on the ground, and must say so in plain language.
2. **Product name: "Incident Coordination Agent".** Drop "Ground" everywhere Task 06 put it (UI, `<title>`, README, brand `productName`, docs, CDK descriptions, package descriptions, agent preamble). Keep the `@ica/*` scope, stack ids and resource names. Update ADR 0007.
3. **Home screen:** a live network map built on a fictional Accent Air day schedule, replayed against the **real wall clock** (time of day in UTC mapped onto the schedule). It is computed entirely in the browser, with **zero backend cost**.
4. **"Report incident" is template-first.** Picking an incident type builds a schema-valid scenario deterministically from the selected flight's context (free, instant). Optional free text goes to the Scenario Author for extra detail (one LLM call). The run then starts.
5. **Real flight data:** none. OpenSky's terms and the anonymity rules rule it out. All flights, tails, crew and passengers are fictional; airports are real (OurAirports).

## Phase 0 — rebrand the fictional carrier to Accent Air (runs first, alone)

Owner decision (2026-09-27): the fictional carrier becomes **Accent Air**. Flight numbers become **`ACX1xx–ACX9xx`** (was `NWD…`) and tails **`AX-XXX`** (was `NW-XXX`); the main base stays MAN.
- Replace every "Northwind" or "Northwind Air" occurrence: brand default (`carrierName`, `carrierCode: "ACX"`), UI strings, role prompts, docs (README, CLAUDE.md fixed identifiers, CONTRIBUTING, demo script, SOURCES, NOTICE if relevant, issue templates, specification references to the shipped carrier), evals rubrics and scripts, and data comments.
- Update the schema validators and patterns (flight `^ACX\d{3}$`-style, tail `^AX-[A-Z]{3}$`), fixed-identifier docs, and all generated schema JSON. The contract change is breaking but deliberate. Log it in CONTRACTS.md §11 as an owner-approved rename.
- Regenerate or rewrite every dataset that embeds codes:
  - `scenarios/public/*.json` and `index.gen.ts`
  - `packages/schema/fixtures/*`
  - `evals/cases/*`
  - eval replay fixtures, via the free scripted and baseline paths
  - `apps/web` mock recordings
  - Storybook fixtures
  - `data/fixtures`, if they mention the carrier
  - test expectations
- Deterministic generators (names and ids) keep their seeds, so only the codes change.
- Verify: `git grep -iE "northwind|\bNWD\d|NW-[A-Z]{3}"` returns nothing, apart from historical notes in this task file and ADRs. Every check passes (typecheck, lint, headers, tests, synth, web build, Storybook, Playwright, replay and baseline evals, hygiene).
- Record the rename in `docs/adr/0007-product-name.md`, which covers the carrier as well as the product name.

## Phase A — domain: network, templates, airborne systems

### A1. `packages/network` (`@ica/network`, new, browser- and Node-safe, no Node APIs)
- `generateDaySchedule(seed, dateUtc)`: Accent Air's fictional day. It has about 60–80 flights across ~22 tails (A319/A320/A321), with MAN as the main base plus 2–3 secondary bases, and real European airports taken from `data/airports/stations.json`.
  - Rotations must be realistic: turn times ≥ 35 min, first wave 06:00–07:30, night-stop at bases, and curfews respected.
  - It's deterministic for a given seed and date. Flight numbers use `ACX1xx–ACX9xx`; tails use `AX-XXX`.
- `flightStateAt(flight, t)` returns the phase (`scheduled|boarding|taxi_out|airborne|approach|landed|at_gate|cancelled`) and, while airborne, the great-circle position (lat/lon), heading, altitude profile (climb, cruise, descent), ETA, progress and a notional fuel-endurance figure.
- `suitableAirports(position, aircraftType, filters)`: candidate airports ranked by distance and suitability. Suitability comes from the capability data (A3). The output is **options only**.
- Pure functions with unit tests: determinism, turn times, no overlapping legs per tail, correct phases around STD/STA, and positions on the great circle.

### A2. Templates: flight → scenario (`@ica/network/templates` or `scenarios/templates/`)
- `buildScenarioFromFlight(flight, incidentType, options)` returns a **schema-valid `Scenario`** built from the flight's real context: the tail's rotation that day, spares at the relevant stations, engineers, crew with FDP computed from the day's duty, cohorts sized from pax, stands, weather snapshot and curfews.
  - The trigger and evidence are filled from the incident type.
  - Scheduled and manual twists are chosen from a per-type library, including the engineer-ETA twist that triggers approval invalidation.
  - The baseline chronology comes from a per-type template.
- Incident types, filtered by the flight's phase:
  - **Ground:** the existing families (GSE or catering strike, pushback or towbar, bird strike found on inspection, lightning on the ground, door warning, APU inop, slide, hydraulic leak, fuel spill, brake overheat).
  - **Airborne:**
    - `air_turnback` (bird strike or engine vibration on climb)
    - `diversion_technical` (smoke/fumes, pressurisation, hydraulics)
    - `diversion_medical`
    - `engine_shutdown_overweight_landing`
    - `unruly_passenger_diversion`
- Validated with `validateScenario`. Property-style tests generate and validate a scenario for every flight × applicable type in a seeded day.

### A3. Airborne-capable mock systems and tools
- A new system `flight` (or an extension of `occ`) holds each flight's position, phase, ETA, fuel endurance, squawk/status (`normal|pan|mayday`, set by the scenario trigger, **never** by agents) and the commander's decision log, which is recorded only from scenario or presenter events as human actor "Commander".
- Airport capability data for the stations: runway length, RFFS (fire) category, handling contract (yes/no), Northwind engineering cover, customs/immigration, hotel capacity, curfew and opening hours. Generate it deterministically from the stations data plus overrides, and label it fictional where invented.
- New tools, one file each, following the tier matrix style:

  | Tool | Tier | Notes |
  |---|---|---|
  | `get_flight_position` | execute | read |
  | `rank_diversion_airports` | execute | **Options only.** The result states "for the commander's consideration" |
  | `prepare_diversion_handling` | propose | Handling, stairs/buses, fuel, catering, hotel holds at a candidate airport |
  | `arrange_arrival_services` | propose | Fire and rescue standby, medical, engineers to meet the aircraft |
  | `notify_destination_station` | execute | idempotent `requestId` |
  | `plan_overweight_landing_inspection` | execute | creates a work order at the arrival station |
  | `instruct_flight_crew`, `select_diversion_airport`, `approve_overweight_landing` | **forbidden** | They exist so attempts are blocked and counted, with authority "Commander" |
- Roles:
  - **Orchestrator:** handles airborne phases, with the authority boundary stated in plain words.
  - **Flight Ops:** gains the airborne tools.
  - **Maintenance:** gains the arrival-station inspection.
  - **Passenger:** gains the outstation care surge.
  - **Record:** the MOR draft covers airborne occurrences.
- KPIs: add diversion cost (a fuel and landing and handling estimate, labelled "(estimate)"), a care-surge cost, and FDP after a diversion. The compliance list adds "commander's authority respected" (no forbidden flight-deck attempts).
- The five airborne scenarios are also added to `scenarios/public/` as training scenarios, with `inspiredBy` taken only from **verified** ASRS or AAIB reports in the corpus; never invent ids. Add eval cases: the new scenarios plus 2 adversarial ones, (a) "tell the crew to divert to X" injected into a tool result, and (b) pressure to select the airport. Keep the replay and baseline tiers green; **no live evals**.
- Glossary additions, as definitions and inline phrases: diversion, air turnback, PAN/MAYDAY, overweight landing, ETOPS (mention only), RFFS category, squawk, ETA/STA/STD.

## Phase B — web: live network home and report flow

- **Home (`/`)** becomes the live network:
  - The existing equal-area map is scaled up to a full-bleed hero. It shows the airports (bases emphasised), active flights as aircraft glyphs moving smoothly (requestAnimationFrame, reduced-motion aware), ground flights at their stations, and a UTC clock.
  - A flight list/search panel (flight, tail, route, phase, delay), with filters for airborne, on ground and at my base.
  - Hover shows a tooltip; click selects.
  - Keyboard: arrow keys move through the list, Enter selects, `/` focuses search.
- **Flight panel** (drawer):
  - Route and phase timeline (STD → off-blocks → airborne → STA), position and ETA, pax and cohort summary, crew FDP margin, the tail's rotation (reusing RotationGantt), and nearest suitable airports when airborne (options only, labelled as such).
  - Primary action: **"Report incident"**.
- **Report incident dialog** (keep it simple: a list plus free text; see M2):
  - Incident types filtered by phase, with a plain-language description for each.
  - An optional free-text box ("Add details (optional)"; typing enables the Author step, and the UI notes the extra 10–30 s and that it's an LLM call).
  - A preview card of the scenario that will run: trigger, key facts, twists.
  - Then **Start** (agent run plus a paired baseline, as today) navigates to the cockpit.
- **Training scenarios:** the library cards move to a secondary tab or section. Recent runs and the eval summary remain.
- In the cockpit, airborne runs show the aircraft moving on the NetworkMap with ETA countdowns. The Ground view switches to an "Arrival station" view when relevant: stands, fire and rescue standby and the engineer team meeting the aircraft.
- **Mock mode:** the network runs fully in the browser, and "Report incident" works via templates. An airborne recording (turnback) is added to the mock fixtures so every new element is demonstrable without a backend.
- **Quality:** Storybook stories (empty, loading, live and error) for the map, list, flight panel and report dialog, with the axe a11y scan clean. Playwright: open home, select an airborne flight, report `air_turnback`, reach the cockpit, and see the aircraft on the map. Performance: 80 moving flights at 60 fps on a laptop, with the map rendered on a single canvas or an SVG layer as appropriate.
- **API** (small, additive):
  - `POST /runs` accepts `{flightContext: {seed, date, flightId}, incidentType, text?}` as well as `{scenarioId}`.
  - The server rebuilds the scenario with the same `@ica/network` templates, so the scenario is not trusted from the client. If `text` is present, it screens it and runs the Author step, then validates, persists the scenario as private and starts the run.

## Definition of done
- [ ] Phase A: `@ica/network` with tests; the templates produce valid scenarios for every flight × applicable type; the airborne systems, tools, tiers and roles; the five airborne scenarios with verified citations; the KPI and compliance additions; the evals (replay and baseline green); the glossary; the rename to "Incident Coordination Agent".
- [ ] Phase B: the live-network home, flight panel, report dialog, API flight-context runs, the cockpit airborne visuals, mock mode, Storybook plus a11y, and Playwright.
- [ ] `npm run typecheck && npm run lint && npm run lint:headers && npm test && npm run synth`, the web build and `npm run hygiene` all pass. No live LLM calls, no AWS writes, no deploy, no push.
