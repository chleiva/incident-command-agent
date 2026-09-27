/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** Traces (NFR-07). Each LLM call is stored at `traces/{runId}/{agentRunId}-i{iteration}.json`. */
import type { TraceStore } from '@ica/schema';
import { redact } from '../llm/errors';

export function traceLabel(agentRunId: string, iteration: number): string {
  return `${agentRunId}-i${String(iteration).padStart(3, '0')}`;
}

/** Store a trace body with anything that looks like an API key redacted. Returns the trace key. */
export async function putTrace(
  traces: TraceStore,
  runId: string,
  label: string,
  body: unknown,
): Promise<string> {
  return traces.put(runId, label, JSON.parse(redact(JSON.stringify(body))));
}
