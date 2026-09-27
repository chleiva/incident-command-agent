# ADR 0007 — Product name and fictional carrier

Status: accepted · 2026-09-27 (amended 2026-09-27 by task 07)

## Context
The final one-page brief named the product **Ground Incident Coordination Agent** (it coordinates ground and pre-departure incidents; it does not "command" anyone). The build was started as "Incident Command Agent", and that name is baked into identifiers that deployments and imports depend on.

Task 07 widens the scope from ground and pre-departure events to ground **and airborne** incidents (turnback, diversion), so the owner dropped "Ground" from the name. At the same time the owner renamed the fictional carrier from "Northwind Air" (`NWD` flights, `NW-XXX` tails) to **Accent Air**.

## Decision
- The product is the **Incident Coordination Agent**. Everything user-visible or descriptive uses this name: the web title bar and `<title>`, the brand pack (`productName`, default "Incident Coordination Agent"), `README.md`, `CLAUDE.md`, `docs/*` headings, the Storybook title, CDK stack and resource descriptions, `package.json` descriptions and the agents' data-handling preamble.
- The fictional carrier is **Accent Air**: flight numbers `ACX100`–`ACX999` (`^ACX[1-9][0-9]{2}$`), tails `AX-` + three capital letters (`^AX-[A-Z]{3}$`), carrier code `ACX`, main base MAN, real IATA airports. Every shipped scenario, fixture, recording and eval case was rewritten with the same seeds, so only the codes changed. This is the one deliberate breaking contract change, logged in `packages/schema/CONTRACTS.md` §11.
- Identifiers stay as they are so nothing breaks: the `@ica/*` package scope, the repository name, CDK stack ids, the DynamoDB table and S3 bucket names, `ica.*` localStorage keys and the `ica/*` secret ids.
- The Apache-2.0 licence header and `NOTICE` keep "Incident Command Agent contributors" as the name of the contributor group (the repository's name); only the product line of `NOTICE` changes.

## Consequences
- Existing deployments update in place (descriptions change; logical ids and physical names do not).
- Private scenarios stored with the old `NWD`/`NW-` codes fail validation and must be re-authored.
- A brand pack loaded from the git-ignored `config/brand.local.json` may override `productName` and the carrier, like every other brand field.
