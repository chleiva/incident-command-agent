# Data sources

Every third-party source used by `npm run kb:build`, `npm run airports:build` and the committed fixtures. Raw downloads go to `data/raw/` and the built index to `data/index/`; both are git-ignored. What **is** committed: `data/airports/stations.json`, `data/params/delay-cost.json`, and the mini-corpus in `data/fixtures/` (only public-domain or reuse-permitted text; no AAIB text).

Retrieval date for everything below: **2026-09-26** (the build records its own date in `data/index/manifest.json` and `build-report.json`). Not used, by design: IATA IGOM/AHM, ICAO Doc 10121, SKYbrary article text, OEM AMM/FCOM, any airline manual or MEL, OpenFlights, OpenSky, ECCAIRS.

| Source | Collection | URL | Licence | Verbatim reuse | Status |
|---|---|---|---|---|---|
| NASA ASRS via Hugging Face `elihoole/asrs-aviation-reports` | `precedent` (US) | https://huggingface.co/datasets/elihoole/asrs-aviation-reports (parquet through `datasets-server.huggingface.co`) | Report text: US Government work, public domain; the Hugging Face packaging is tagged Apache-2.0 | Yes, with NASA's disclaimer (and dataset credit) | OK: 47,723 reports scanned, air-carrier reports filtered by ground/pre-departure/maintenance keywords and flight phase, capped at 4,000 (`KB_ASRS_CAP`), ≤ 2 chunks each |
| UK AAIB reports (GOV.UK search + content APIs, bulletin PDFs) | `precedent` (UK) | https://www.gov.uk/aaib-reports | Open Government Licence v3.0 | Yes, with the OGL attribution | OK: 20 ground-event queries, commercial fixed-wing, capped at 150 reports (`KB_AAIB_CAP`), 1 request/s, descriptive user agent, ≤ 6 chunks each |
| FAA Accident and Incident Data System | `precedent` (US) | https://www.asias.faa.gov/ | Public domain | Yes | **FAILED**: the ASIAS download page returns HTTP 403 to scripted clients. Tolerated; set `KB_AIDS_URL` to a CSV/TSV export to include it |
| FAA A-320 MMEL, Rev 32 (draft) | `mel` (US) | https://www.faa.gov/aircraft/draft_docs/mmel/MMEL_A-320_Rev_32_Draft.pdf | US Government work, public domain | Yes (items quoted verbatim, PDF line wraps re-flowed) | OK: one chunk per MMEL item (number, title, repair category, remarks/exceptions) plus the preamble |
| EASA Easy Access Rules for Air Operations (March 2026) | `rules` (EU) | https://www.easa.europa.eu/en/document-library/easy-access-rules/easy-access-rules-air-operations | © European Union, 1998-2026; re-use authorised with acknowledgement (EUR-Lex legal notice) | Yes, with attribution | OK: implementing-rule text only of ORO.MLR.105, ORO.FTL.100–250 (incl. ORO.FTL.205) and CAT.GEN.MPA.105 |
| FAA AC 150/5210-20A Ground Vehicle Operations to include Taxiing or Towing an Aircraft on Airports | `procedure` (US) | https://www.faa.gov/documentLibrary/media/Advisory_Circular/150-5210-20A.pdf | US Government work, public domain | Yes | OK |
| UK CAA CAP 642 Airside Safety Management | `procedure` (UK) | https://www.caa.co.uk/publication/download/12196 | © UK Civil Aviation Authority | Quoted with attribution ("Source: UK Civil Aviation Authority, CAP 642") | OK |
| Airbus Safety First ground-operations articles (article PDFs) | `procedure` | https://safetyfirst.airbus.com/ground-ops/ | "Articles may be reprinted without permission, except where copyright source is indicated, but with acknowledgement to Airbus" (safetyfirst.airbus.com/about) | Yes, with acknowledgement to Airbus; articles indicating another copyright source are skipped | OK: up to 14 articles, 1 request/s |
| Flight Safety Foundation ramp procedures template | `procedure` | set `KB_FSF_URL` | Redistribution unconfirmed | **No** | Skipped by default; only with `KB_INCLUDE_FSF=true`, for local use, never uploaded or committed |
| Regulation (EC) No 261/2004 | `passenger_rights` (EU) | https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32004R0261 (fetched from the Publications Office cellar, `publications.europa.eu/resource/celex/32004R0261`, because EUR-Lex challenges scripted clients) | © European Union; re-use under Commission Decision 2011/833/EU | Yes, with source acknowledgement | OK: one section per article |
| UK CAA passenger-rights pages (delays, cancellations, compensation) | `passenger_rights` (UK) | https://www.caa.co.uk/air-passengers/travel-problems-and-rights/flight-delays-and-cancellations/ | © UK Civil Aviation Authority | Quoted with attribution ("Source: UK Civil Aviation Authority") | OK: 4 pages |
| EUROCONTROL Standard Inputs for Economic Analyses — cost of delay | params → `data/params/delay-cost.json` | https://ansperformance.eu/economics/cba/standard-inputs/latest/chapters/cost_of_delay.html | EUROCONTROL; free to use with attribution | Figures cited with attribution | OK: 4 tables copied as published; the KPI defaults (€100/min, factor 1.8) remain the spec's and cite this file |
| OurAirports `airports.csv` | stations → `data/airports/stations.json` | https://ourairports.com/data/airports.csv | Public domain (The Unlicense) | Yes | OK: European large and medium airports with scheduled service and an IATA code, plus every scenario station |
| NOAA Aviation Weather Center data API (optional, runtime only) | `get_weather` live METAR | https://aviationweather.gov/api/data/metar | US Government work, public domain | Yes | Only when `FEATURE_LIVE_WEATHER=true`; results are untrusted data |
| Embedding model `Xenova/all-MiniLM-L6-v2` (transformers.js) | index embeddings | https://huggingface.co/Xenova/all-MiniLM-L6-v2 | Apache-2.0 | n/a (model weights are downloaded to a cache, not committed) | Default `KB_EMBEDDINGS=local`, free |

## Attribution texts

- **NASA ASRS:** "ASRS reports are submitted voluntarily and are not verified by NASA; they may be incomplete or inaccurate and must not be used to infer the frequency of any event." This disclaimer is stored in every ASRS chunk (`meta.disclaimer`) and repeated by the precedent tools.
- **AAIB:** "Contains public sector information licensed under the Open Government Licence v3.0." (stored in `meta.attribution`).
- **EASA:** "© European Union, 1998-2026. Source: EASA Easy Access Rules for Air Operations (Regulation (EU) No 965/2012)."
- **UK CAA:** "Source: UK Civil Aviation Authority" (CAP 642; passenger-rights pages).
- **Airbus:** "Reprinted with acknowledgement to Airbus (Safety First magazine, safetyfirst.airbus.com)."
- **EU 261/2004:** "© European Union, https://eur-lex.europa.eu, 1998-2026."
- **EUROCONTROL:** "Source: EUROCONTROL Standard Inputs for Economic Analyses."
- **OurAirports:** "Airport data from OurAirports (public domain)."

## Scenario references (`inspiredBy`)

The shipped scenarios cite only ASRS accession numbers (ACN) and one AAIB report that were found in the downloaded corpus on the retrieval date; the scenarios themselves are fictional (Accent Air) and do not reproduce any report. ASRS ACNs have no public per-report URL, so they link to the dataset page.

## Fixture mini-corpus (`data/fixtures/`)

32 chunks, rebuilt with `npm run kb:fixtures -w @ica/kb` after a `kb:build`: 5 FAA MMEL items, 5 EASA rule chunks, 8 passenger-rights chunks (EU 261/2004, UK CAA), 6 procedure chunks (CAP 642, FAA AC, Airbus Safety First) and 8 de-identified ASRS narratives. `data/fixtures/index/` is a tiny prebuilt index (BM25 + int8 MiniLM embeddings) and `query-vectors.json` stores three query embeddings so tests exercise hybrid retrieval without loading the model.
