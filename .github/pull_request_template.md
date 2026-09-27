## What and why

## How to verify

- [ ] `npm run typecheck && npm run lint && npm run lint:headers && npm test`
- [ ] `npm run hygiene` (if data, scenarios or docs changed)

## Checklist

- [ ] Fictional carrier only; no client/airline/consultancy names, no real personal data, no proprietary manual text
- [ ] No keys or `.env`, `config/brand.local.json`, `scenarios/private/`, `data/raw/` content
- [ ] Contract changes (`packages/schema`, `packages/store`) are additive and listed in `CONTRACTS.md`
- [ ] Autonomy tiers unchanged, or the change is deliberate and evals are updated
- [ ] Zero live LLM calls in tests; any live spend is stated here: £___
