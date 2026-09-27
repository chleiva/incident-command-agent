/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Amazon Bedrock Converse adapter (`toolConfig`). The only adapter that uses an AWS SDK, because requests need
 * SigV4 signing. The SDK is imported lazily so tests and non-Bedrock runs never load it.
 */
import type { LlmMessage, LlmProvider, LlmRequest, LlmResponse, LlmStopReason } from '@ica/schema';
import { LlmHttpError, LlmNetworkError } from './errors';

export interface BedrockOptions {
  region?: string;
  /** Injected for tests: `send(ConverseCommand-like input)` → Converse output. */
  send?: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

type Obj = Record<string, unknown>;

function toBedrockMessages(messages: LlmMessage[]): Obj[] {
  return messages.map((m) => ({
    role: m.role,
    content: m.content.map((b): Obj => {
      if (b.type === 'text') return { text: b.text };
      if (b.type === 'tool_use') return { toolUse: { toolUseId: b.id, name: b.name, input: b.input } };
      return {
        toolResult: {
          toolUseId: b.toolUseId,
          content: [{ text: b.content }],
          status: b.isError ? 'error' : 'success',
        },
      };
    }),
  }));
}

export function buildConverseInput(req: LlmRequest): Obj {
  const input: Obj = {
    modelId: req.model,
    system: [{ text: req.system }],
    messages: toBedrockMessages(req.messages),
    inferenceConfig: { maxTokens: req.maxTokens, temperature: req.temperature },
  };
  if (req.tools.length) {
    input.toolConfig = {
      tools: req.tools.map((t) => ({
        toolSpec: { name: t.name, description: t.description, inputSchema: { json: t.inputSchema } },
      })),
      toolChoice: { auto: {} },
    };
  }
  return input;
}

const STOP: Record<string, LlmStopReason> = {
  end_turn: 'end_turn',
  tool_use: 'tool_use',
  max_tokens: 'max_tokens',
  stop_sequence: 'stop_sequence',
};

export function parseConverseOutput(out: Obj, model: string): LlmResponse {
  const content = (((out.output as Obj)?.message as Obj)?.content as Obj[]) ?? [];
  const text = content
    .filter((c) => typeof c.text === 'string')
    .map((c) => c.text as string)
    .join('\n')
    .trim();
  const toolCalls = content
    .filter((c) => c.toolUse)
    .map((c) => {
      const t = c.toolUse as Obj;
      return { id: String(t.toolUseId), name: String(t.name), input: (t.input as Obj) ?? {} };
    });
  const u = (out.usage as Record<string, number>) ?? {};
  return {
    text,
    toolCalls,
    usage: {
      inputTokens: u.inputTokens ?? 0,
      outputTokens: u.outputTokens ?? 0,
      cacheReadTokens: u.cacheReadInputTokens ?? 0,
      cacheWriteTokens: u.cacheWriteInputTokens ?? 0,
    },
    stopReason: STOP[String(out.stopReason)] ?? 'other',
    model,
    raw: out,
  };
}

export function createBedrockProvider(opts: BedrockOptions = {}): LlmProvider {
  let send = opts.send;
  const getSend = async () => {
    if (send) return send;
    const sdk = await import('@aws-sdk/client-bedrock-runtime');
    const client = new sdk.BedrockRuntimeClient({ region: opts.region ?? process.env.AWS_REGION });
    send = async (input) =>
      (await client.send(
        new sdk.ConverseCommand(input as unknown as ConstructorParameters<typeof sdk.ConverseCommand>[0]),
      )) as unknown as Obj;
    return send;
  };
  return {
    id: 'bedrock',
    async complete(req: LlmRequest): Promise<LlmResponse> {
      const s = await getSend();
      try {
        return parseConverseOutput(await s(buildConverseInput(req)), req.model);
      } catch (err) {
        const e = err as { $metadata?: { httpStatusCode?: number }; message?: string; name?: string };
        const status = e.$metadata?.httpStatusCode;
        if (status) throw new LlmHttpError('bedrock', status, e.message ?? String(err));
        if (e.name === 'AbortError') throw err;
        throw new LlmNetworkError('bedrock', err);
      }
    },
  };
}
