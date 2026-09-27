# ADR 0001 — No agent framework: one hand-written ReAct loop

Status: accepted · 2026-09-26

## Context
The system coordinates an orchestrator and five specialist agents that call ~30 tools on stateful mocked systems. Authority must be enforced in code (execute / propose / forbidden tiers), every step must become an event, and prompts, tool schemas and traces must be fully under our control. Agent frameworks add abstractions over exactly these points (tool dispatch, memory, retries) and change quickly.

## Decision
Write a single `runAgent(role, brief, ctx)` ReAct loop (`services/run/runtime`). Roles are data (`RoleDefinition`: constant system prompt, tool subset, report schema, stop condition). Sub-agents are ordinary `delegate` tool calls that recurse into the same loop and can run concurrently. No LangChain, LangGraph, CrewAI or vendor agent SDK.

## Consequences
- Tier enforcement, argument/reference validation, output screening, budgets and events live in one small loop we can test exhaustively with `scripted` and `replay` providers.
- Adding an agent means adding a role file, not code.
- We own features a framework would give us (retries, fallback, tracing); they are small and specified in task 02.
