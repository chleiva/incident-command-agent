# Scenarios

Ten shipped scenarios live in `public/` (CC BY 4.0, fictional carrier **Accent Air**). Each is one JSON file named after its id and validated against `packages/schema/scenario.schema.json` (`schemaVersion: 1`, strict: unknown fields are rejected).

| id | Station | Key twist |
|---|---|---|
| `s01-pushback-tug-contact` | MAN | Second tug unavailable |
| `s02-catering-truck-door-strike` | PMI | Engineer flight delayed |
| `s03-bird-strike-inspection` | EDI | Remains found in engine intake |
| `s04-lightning-strike-outstation` | FAO | Options case: fly an engineer in vs. drive one vs. cancel |
| `s05-cargo-door-warning` | MAN | Warning clears, then returns |
| `s06-apu-inop-deferral-temptation` | AGP | Handler pushes for a quick deferral |
| `s07-slide-inadvertent-deployment` | DUB | PRM passenger on board |
| `s08-hydraulic-leak-on-stand` | MAN | Stand needed for inbound flight |
| `s09-fuel-spill-at-stand` | ALC | Stand closure extended |
| `s10-brake-overheat-fdp-squeeze` | TFS | Home-base curfew approaching |

```bash
npm run scenarios:validate   # validates public/ and private/, regenerates public/index.gen.ts
```

## Writing a scenario

1. **Identity.** Only fictional data: Accent Air, flight numbers `ACX100`–`ACX999`, tails `AX-` + three capital letters, main base MAN, fictional people (use invented names such as those in `services/run/systems/names.ts`) and fictional handling companies. Airports are real IATA codes (check them in `data/airports/stations.json`; run `npm run airports:build` if you add a station outside Europe). Never use a real airline, operator, registration, flight number or person.
2. **Clock.** `startSimTime` is sim minute 0; all ISO times are UTC (`Z`). `trigger.atMinute`, twist `atMinute` and baseline `atMinute` are sim minutes. Rotation legs that departed before minute 0 are treated as already flown.
3. **Aircraft and trigger.** `aircraft.nextSectors` lists the incident tail's remaining sectors (with great-circle `distanceKm`); the trigger becomes an open defect `DEF-001` in the M&E system. Quote any MEL item in evidence as `MEL 49-10-01` so it is linked to the defect.
4. **World.** Give every specialist something to do: at least one spare somewhere (none at the station is a valid design choice, as in s04), engineers at different distances with licences (`B1` structures/mechanical, `B2` avionics) and `availableFromMinute`, operating crew with realistic `maxFdpMin` (EASA ORO.FTL.205 table) and standby crew, 3–6 passenger cohorts including PRM and connections (with `onwardDeadline`), stands with occupancy, handler equipment and response time, a weather snapshot, curfews (local `HH:MM` at the station) and the day's `rotation` for the incident tail and any other tail you reference.
5. **Twists.** At least one scheduled (`atMinute`) and one manual (no `atMinute`, injected by the presenter). Effects: `patch` (entity map + id + partial fields), `create` (a full entity record), `delay` (a flight, minutes) or `info` (text shown to agents as untrusted data). Entity names are the `SYSTEM_ENTITIES` names in `@ica/schema` (for example `engineers`/`engineers`, `handler`/`equipment` with id `MAN:tug`).
6. **Baseline.** How a human team would plausibly handle it today, with slower, phone-driven timings (first passenger message around minutes 25–40). Every step uses the **same tool names and arguments as the agents**, because baseline mode executes them through the real tool handlers; `propose` tools need `decision: "approve"` or `"reject"`, and `forbidden` tools (`defer_defect`, `release_aircraft`, `extend_crew_fdp`) can never appear. A deferral taken by a certifying engineer is recorded with `record_engineering_decision`.
7. **Expected.** Hard constraints (`noSoftwareDeferral`, `noFdpExtension`), latency targets (`firstPaxMessageBeforeMin: 15` etc.), required and forbidden tools, ordered tool pairs such as `["page_engineer", "propose_swap"]`, and a one-paragraph `referenceSummary` describing a good response.
8. **KPI parameters.** Start from the defaults (€100/min, reactionary factor 1.8, €18,600 cancellation, €8 care per passenger-hour, €120 accommodation); override with a reason, citing `data/params/delay-cost.json` where relevant.
9. **`inspiredBy`.** Only report ids you found in the downloaded corpus (`search_precedents`, or `data/raw/chunks/asrs.jsonl` after `npm run kb:build`), e.g. `ASRS ACN 1577181` with the dataset URL, or an AAIB report URL on gov.uk. **Never invent a report id**; leave the list empty if you cannot verify one.
10. Run `npm run scenarios:validate`, then `npm test -w @ica/run` (the scenario test replays every baseline step through the real tools and checks twist targets).

The Scenario Author agent (`POST /scenarios/author`) follows the same rules and checks its output with the `validate_scenario` tool.

## Private scenarios

Client or confidential scenarios go in `scenarios/private/*.json` with `"visibility": "private"`. The folder is **git-ignored** and must never be committed; the pre-commit hook and `npm run hygiene` also block configured private words. `npm run scenarios:validate` validates them alongside the public ones (they are not added to `public/index.gen.ts`), and `npm run scenarios:push` (task 04) uploads them to a deployment's store. Keep private scenarios anonymised in the same way unless the deployment is private to that client.

## Licence

Scenario files are licensed under CC BY 4.0 (see `LICENSE-content`). The narratives are fictional; the real reports listed in `inspiredBy` keep their own licences (see `data/SOURCES.md`).
