/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** OpenAI Responses API adapter over direct `fetch` (function tools). Stateless: the full input is sent each call. */
import type { LlmMessage, LlmProvider, LlmRequest, LlmResponse, LlmStopReason } from '@ica/schema';
import { LlmHttpError, LlmNetworkError, parseRetryAfter } from './errors';

export interface OpenAiOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

type Item = Record<string, unknown>;

function toInput(messages: LlmMessage[]): Item[] {
  const out: Item[] = [];
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === 'text') {
        out.push({
          role: m.role,
          content: [{ type: m.role === 'user' ? 'input_text' : 'output_text', text: b.text }],
        });
      } else if (b.type === 'tool_use') {
        out.push({ type: 'function_call', call_id: b.id, name: b.name, arguments: JSON.stringify(b.input) });
      } else {
        out.push({ type: 'function_call_output', call_id: b.toolUseId, output: b.content });
      }
    }
  }
  return out;
}

export function buildOpenAiBody(req: LlmRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model,
    instructions: req.system,
    input: toInput(req.messages),
    max_output_tokens: req.maxTokens,
    store: false,
  };
  if (req.tools.length) {
    body.tools = req.tools.map((t) => ({
      type: 'function',
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
      strict: false,
    }));
    body.tool_choice = 'auto';
  }
  if (!/^(gpt-5|o\d)/.test(req.model)) body.temperature = req.temperature;
  return body;
}

export function parseOpenAiResponse(json: Record<string, unknown>, model: string): LlmResponse {
  const output = (json.output as Item[] | undefined) ?? [];
  const texts: string[] = [];
  const toolCalls: LlmResponse['toolCalls'] = [];
  for (const item of output) {
    if (item.type === 'message') {
      for (const c of (item.content as Item[]) ?? []) {
        if (c.type === 'output_text') texts.push(String(c.text ?? ''));
      }
    } else if (item.type === 'function_call') {
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(String(item.arguments ?? '{}')) as Record<string, unknown>;
      } catch {
        input = { _unparseable: String(item.arguments) };
      }
      toolCalls.push({ id: String(item.call_id ?? item.id), name: String(item.name), input });
    }
  }
  const u = (json.usage as Record<string, unknown> | undefined) ?? {};
  const cached = Number((u.input_tokens_details as Record<string, number> | undefined)?.cached_tokens ?? 0);
  const status = String(json.status ?? '');
  const stopReason: LlmStopReason = toolCalls.length
    ? 'tool_use'
    : status === 'incomplete'
      ? 'max_tokens'
      : status === 'completed'
        ? 'end_turn'
        : 'other';
  return {
    text: texts.join('\n').trim(),
    toolCalls,
    usage: {
      inputTokens: Math.max(0, Number(u.input_tokens ?? 0) - cached),
      outputTokens: Number(u.output_tokens ?? 0),
      cacheReadTokens: cached,
      cacheWriteTokens: 0,
    },
    stopReason,
    model: String(json.model ?? model),
    raw: json,
  };
}

export function createOpenAiProvider(opts: OpenAiOptions): LlmProvider {
  const f = opts.fetch ?? fetch;
  const url = `${opts.baseUrl ?? 'https://api.openai.com'}/v1/responses`;
  return {
    id: 'openai',
    async complete(req: LlmRequest): Promise<LlmResponse> {
      let res: Response;
      try {
        res = await f(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.apiKey}` },
          body: JSON.stringify(buildOpenAiBody(req)),
          signal: req.signal,
        });
      } catch (err) {
        if ((err as Error)?.name === 'AbortError') throw err;
        throw new LlmNetworkError('openai', err);
      }
      const text = await res.text();
      if (!res.ok) {
        throw new LlmHttpError('openai', res.status, text, parseRetryAfter(res.headers.get('retry-after')));
      }
      return parseOpenAiResponse(JSON.parse(text) as Record<string, unknown>, req.model);
    },
  };
}
