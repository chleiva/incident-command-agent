# ADR 0007 — Product name: Ground Incident Coordination Agent

Status: accepted · 2026-09-27

## Context
The final one-page brief names the product **Ground Incident Coordination Agent** (it coordinates ground and pre-departure incidents; it does not "command" anyone). The build was started as "Incident Command Agent", and that name is baked into identifiers that deployments and imports depend on.

## Decision
- Everything user-visible or descriptive uses the new name: the web title bar and `<title>`, the brand pack (`productName`, default "Ground Incident Coordination Agent"), `README.md`, `CLAUDE.md`, `docs/*` headings, the Storybook title, CDK stack and resource descriptions, `package.json` descriptions and the agents' data-handling preamble.
- Identifiers stay as they are so nothing breaks: the `@ica/*` package scope, the repository name, CDK stack ids, the DynamoDB table and S3 bucket names, `ica.*` localStorage keys and the `ica/*` secret ids.
- The Apache-2.0 licence header and `NOTICE` keep "Incident Command Agent contributors" as the name of the contributor group (the repository's name); only the product line of `NOTICE` changes.

## Consequences
- Existing deployments update in place (descriptions change; logical ids and physical names do not).
- A brand pack loaded from the git-ignored `config/brand.local.json` may override `productName`, like every other brand field.
