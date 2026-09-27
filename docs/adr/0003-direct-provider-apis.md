# ADR 0003 — Direct provider APIs behind one interface

Status: accepted · 2026-09-26

## Context
The spec requires Anthropic (default), OpenAI and Amazon Bedrock to be selectable by configuration (NFR-02), deterministic-enough runs (NFR-03) and full traces (NFR-07), without SDK lock-in.

## Decision
One `LlmProvider.complete(req)` interface with a provider-neutral message format. Anthropic (Messages API) and OpenAI (Responses API) adapters use `fetch` directly; Bedrock (Converse) uses the AWS SDK only because SigV4 signing is required. Two extra providers: `replay` (recorded traces; the NFR-03 fallback and the free CI eval path) and `scripted` (unit tests). Prompt caching is enabled on Anthropic for the system prompt and the scenario block. Prices come from `config/pricing.json`.

## Consequences
- No vendor SDK in the Run Lambda bundle except the Bedrock client.
- Each adapter maps usage fields (including cache reads/writes) to one `LlmUsage` shape for cost accounting.
- Provider API changes are absorbed in one small adapter each.
