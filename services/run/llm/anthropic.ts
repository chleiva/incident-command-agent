/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Anthropic Messages API adapter over direct `fetch` (no SDK: spec "no SDK lock-in", ADR 0003).
 *
 * - Tools: `tools[].input_schema`, `tool_choice: {type:'auto'}` (forced tool choice is rejected by newer models).
 * - Prompt caching: `cache_control: {type:'ephemeral'}` on the system prompt, on the last tool, on any text block
 *   flagged `cache` (the `<scenario_data>` block) and, with `cacheHints.messages`, a moving breakpoint on the last
 *   message block. At most 4 breakpoints are sent.
 * - Sampling: Sonnet 5 / Opus 4.7+ / Opus 5.x / Fable reject `temperature` (400), so it is omitted for them; the
 *   runtime still enforces `LLM_TEMPERATURE ≤ 0.2` for the models that accept it (NFR-03).
 * - Thinking: disabled where the model allows it (cheaper, and no thinking blocks to round-trip); for models where
 *   thinking cannot be disabled, the native assistant content is returned as `providerContent` and echoed back.
 */
import type {
  LlmContentBlock,
  LlmMessage,
  LlmProvider,
  LlmRequest,
  LlmResponse,
  LlmStopReason,
} from '@ica/schema';
import { LlmHttpError, LlmNetworkError, parseRetryAfter } from './errors';

export const ANTHROPIC_VERSION = '2023-06-01';

export interface AnthropicOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

interface ModelCaps {
  sampling: boolean;
  thinking: 'disable' | 'omit';
}

/** Per-model request surface (see the claude-api skill model table). */
export function anthropicModelCaps(model: string): ModelCaps {
  const m = model.toLowerCase();
  if (/haiku|sonnet-4-[0-6]|opus-4-[0-6]|claude-3/.test(m)) return { sampling: true, thinking: 'omit' };
  if (/sonnet-5|opus-4-[78]/.test(m)) return { sampling: false, thinking: 'disable' };
  // Opus 5.x, Fable, Mythos and unknown future models: thinking always on, no sampling params.
  return { sampling: false, thinking: 'omit' };
}

type Block = Record<string, unknown>;
const EPHEMERAL = { type: 'ephemeral' } as const;

function toAnthropicContent(msg: LlmMessage, model: string): Block[] {
  if (msg.role === 'assistant' && msg.providerContent?.provider === 'anthropic') {
    if (msg.providerContent.model === model) return structuredClone(msg.providerContent.content) as Block[];
  }
  return msg.content.map((b: LlmContentBlock): Block => {
    switch (b.type) {
      case 'text':
        return b.cache
          ? { type: 'text', text: b.text, cache_control: EPHEMERAL }
          : { type: 'text', text: b.text };
      case 'tool_use':
        return { type: 'tool_use', id: b.id, name: b.name, input: b.input };
      case 'tool_result':
        return {
          type: 'tool_result',
          tool_use_id: b.toolUseId,
          content: b.content,
          ...(b.isError ? { is_error: true } : {}),
        };
    }
  });
}

/** Build the Messages API body. Exported for tests (no network). */
export function buildAnthropicBody(req: LlmRequest): Record<string, unknown> {
  const caps = anthropicModelCaps(req.model);
  let breakpoints = 0;
  const system: Block[] = [{ type: 'text', text: req.system }];
  if (req.cacheHints?.system !== false) {
    system[0].cache_control = EPHEMERAL;
    breakpoints++;
  }
  const tools: Block[] = req.tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));
  if (tools.length && req.cacheHints?.tools) {
    tools[tools.length - 1].cache_control = EPHEMERAL;
    breakpoints++;
  }
  const messages = req.messages.map((m) => ({ role: m.role, content: toAnthropicContent(m, req.model) }));
  // Count explicit cache flags on text blocks; drop extras beyond the 4-breakpoint limit.
  for (const m of messages) {
    for (const b of m.content) {
      if (b.cache_control) {
        if (breakpoints >= 4) delete b.cache_control;
        else breakpoints++;
      }
    }
  }
  if (req.cacheHints?.messages && breakpoints < 4 && messages.length) {
    const last = messages[messages.length - 1].content;
    const tail = last[last.length - 1];
    if (tail && !tail.cache_control && tail.type !== 'thinking' && tail.type !== 'redacted_thinking') {
      tail.cache_control = EPHEMERAL;
    }
  }
  const body: Record<string, unknown> = {
    model: req.model,
    max_tokens: req.maxTokens,
    system,
    messages,
  };
  if (tools.length) {
    body.tools = tools;
    body.tool_choice = { type: 'auto' };
  }
  if (caps.sampling) body.temperature = req.temperature;
  if (caps.thinking === 'disable') body.thinking = { type: 'disabled' };
  return body;
}

const STOP: Record<string, LlmStopReason> = {
  end_turn: 'end_turn',
  tool_use: 'tool_use',
  max_tokens: 'max_tokens',
  stop_sequence: 'stop_sequence',
  refusal: 'refusal',
};

/** Parse a Messages API response. Exported for tests. */
export function parseAnthropicResponse(json: Record<string, unknown>, model: string): LlmResponse {
  const content = (json.content as Block[] | undefined) ?? [];
  const text = content
    .filter((b) => b.type === 'text')
    .map((b) => String(b.text ?? ''))
    .join('\n')
    .trim();
  const toolCalls = content
    .filter((b) => b.type === 'tool_use')
    .map((b) => ({
      id: String(b.id),
      name: String(b.name),
      input: (b.input as Record<string, unknown>) ?? {},
    }));
  const u = (json.usage as Record<string, number> | undefined) ?? {};
  const hasThinking = content.some((b) => b.type === 'thinking' || b.type === 'redacted_thinking');
  return {
    text,
    toolCalls,
    usage: {
      inputTokens: u.input_tokens ?? 0,
      outputTokens: u.output_tokens ?? 0,
      cacheReadTokens: u.cache_read_input_tokens ?? 0,
      cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
    },
    stopReason: STOP[String(json.stop_reason)] ?? 'other',
    model: String(json.model ?? model),
    raw: json,
    ...(hasThinking ? { providerContent: { provider: 'anthropic' as const, model, content } } : {}),
  };
}

export function createAnthropicProvider(opts: AnthropicOptions): LlmProvider {
  const f = opts.fetch ?? fetch;
  const url = `${opts.baseUrl ?? 'https://api.anthropic.com'}/v1/messages`;
  return {
    id: 'anthropic',
    async complete(req: LlmRequest): Promise<LlmResponse> {
      let res: Response;
      try {
        res = await f(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': opts.apiKey,
            'anthropic-version': ANTHROPIC_VERSION,
          },
          body: JSON.stringify(buildAnthropicBody(req)),
          signal: req.signal,
        });
      } catch (err) {
        if ((err as Error)?.name === 'AbortError') throw err;
        throw new LlmNetworkError('anthropic', err);
      }
      const text = await res.text();
      if (!res.ok) {
        throw new LlmHttpError(
          'anthropic',
          res.status,
          text,
          parseRetryAfter(res.headers.get('retry-after')),
        );
      }
      return parseAnthropicResponse(JSON.parse(text) as Record<string, unknown>, req.model);
    },
  };
}
