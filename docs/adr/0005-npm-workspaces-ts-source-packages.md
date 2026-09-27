# ADR 0005 — npm workspaces with TypeScript-source packages

Status: accepted · 2026-09-26

## Context
Ten packages (schema, store, ui-tokens, run, api, web, infra, evals, kb, scenarios) are built in parallel by several agents and bundled by three tools (esbuild via CDK `NodejsFunction`, Vite, Vitest).

## Decision
npm workspaces (no pnpm/yarn), ESM everywhere, TypeScript 5 `strict` with `moduleResolution: "bundler"`. Packages export their TypeScript source (`"exports": {".": "./src/index.ts"}`) with no pre-build step; each bundler compiles what it imports. Vitest for tests, ESLint flat config + typescript-eslint, Prettier, an Apache-2.0 header on every source file. TypeBox is the single source of truth for types and JSON Schemas; Ajv (2020-12) validates.

## Consequences
- No stale `dist/` between packages; a change in `@ica/schema` is visible everywhere immediately.
- Node cannot run the TypeScript directly: scripts use `tsx`, Lambdas are bundled by esbuild.
- JSON imports use import attributes (`with { type: 'json' }`).
