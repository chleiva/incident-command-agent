/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import type { LlmRequest } from '@ica/schema';
import { VirtualClock } from '../world/clock';
import {
  anthropicModelCaps,
  buildAnthropicBody,
  createAnthropicProvider,
  parseAnthropicResponse,
} from './anthropic';
import { buildConverseInput, createBedrockProvider, parseConverseOutput } from './bedrock';
import { assertTemperature, llmConfigFromEnv } from './config';
import { LlmHttpError, redact, withRetry } from './errors';
import { buildOpenAiBody, parseOpenAiResponse } from './openai';
import { costUsd, priceFor, worstCaseUsd } from './pricing';
import { createReplayProvider, traceFileName } from './replay';
import { LlmRouter } from './router';
import { createScriptedProvider } from './scripted';

/** Assembled at runtime so secret scanners don't flag a key-shaped literal. */
const TEST_KEY = ['sk', 'ant', 'test', '123456789'].join('-');

const REQ: LlmRequest = {
  model: 'claude-sonnet-5',
  system: 'SYSTEM',
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: '<scenario_data>x</scenario_data>', cache: true },
        { type: 'text', text: 'brief' },
      ],
    },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'ok' },
        { type: 'tool_use', id: 't1', name: 'get_x', input: { a: 1 } },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', toolUseId: 't1', content: '<tool_result>1</tool_result>', isError: true },
      ],
    },
  ],
  tools: [
    { name: 'get_x', description: 'x', inputSchema: { type: 'object', properties: {} } },
    { name: 'report', description: 'r', inputSchema: { type: 'object', properties: {} } },
  ],
  maxTokens: 1000,
  temperature: 0.2,
  cacheHints: { system: true, tools: true, messages: true },
};

describe('anthropic adapter', () => {
  it('builds a Messages API body with tools, cache breakpoints (≤4) and model-appropriate sampling', () => {
    const body = buildAnthropicBody(REQ) as Record<string, any>;
    expect(body.tool_choice).toEqual({ type: 'auto' });
    expect(body.tools[1].input_schema).toEqual({ type: 'object', properties: {} });
    expect(body.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(body.tools[1].cache_control).toEqual({ type: 'ephemeral' });
    expect(body.messages[0].content[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(body.messages[2].content[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 't1',
      is_error: true,
      cache_control: { type: 'ephemeral' },
    });
    const count = JSON.stringify(body).match(/cache_control/g)!.length;
    expect(count).toBeLessThanOrEqual(4);
    // Sonnet 5 rejects temperature; thinking is disabled
    expect(body.temperature).toBeUndefined();
    expect(body.thinking).toEqual({ type: 'disabled' });
    const haiku = buildAnthropicBody({ ...REQ, model: 'claude-haiku-4-5' }) as Record<string, any>;
    expect(haiku.temperature).toBe(0.2);
    expect(haiku.thinking).toBeUndefined();
    expect(anthropicModelCaps('claude-opus-5-5')).toEqual({ sampling: false, thinking: 'omit' });
  });

  it('Sonnet 5.5 turns thinking off with between_tools (disabled is a 400) and sends no temperature', () => {
    const body = buildAnthropicBody({ ...REQ, model: 'claude-sonnet-5-5' }) as Record<string, any>;
    expect(body.thinking).toEqual({ type: 'between_tools' });
    expect(body.temperature).toBeUndefined();
    expect(body.tool_choice).toEqual({ type: 'auto' }); // forced tool_choice is a 400 on Sonnet 5.5
    expect(anthropicModelCaps('claude-sonnet-5-5')).toEqual({ sampling: false, thinking: 'between_tools' });
    // Sonnet 5 keeps the explicit disabled mode.
    const s5 = buildAnthropicBody({ ...REQ, model: 'claude-sonnet-5' }) as Record<string, any>;
    expect(s5.thinking).toEqual({ type: 'disabled' });
  });

  it('parses text, tool calls, stop reason and usage including cache reads/writes', () => {
    const r = parseAnthropicResponse(
      {
        model: 'claude-sonnet-5',
        stop_reason: 'tool_use',
        content: [
          { type: 'text', text: 'Paging now.' },
          { type: 'tool_use', id: 'tu1', name: 'page_engineer', input: { engineerId: 'e1' } },
        ],
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 50,
        },
      },
      'claude-sonnet-5',
    );
    expect(r.text).toBe('Paging now.');
    expect(r.toolCalls).toEqual([{ id: 'tu1', name: 'page_engineer', input: { engineerId: 'e1' } }]);
    expect(r.stopReason).toBe('tool_use');
    expect(r.usage).toEqual({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 50 });
    expect(r.providerContent).toBeUndefined();
  });

  it('round-trips thinking blocks as providerContent for the same model only', () => {
    const content = [
      { type: 'thinking', thinking: '', signature: 'sig' },
      { type: 'text', text: 'hi' },
    ];
    const r = parseAnthropicResponse({ content, stop_reason: 'end_turn', usage: {} }, 'claude-opus-5-5');
    expect(r.providerContent).toEqual({ provider: 'anthropic', model: 'claude-opus-5-5', content });
    const msg = {
      role: 'assistant' as const,
      content: [{ type: 'text' as const, text: 'hi' }],
      providerContent: r.providerContent,
    };
    const hints = { system: true, tools: true, messages: false };
    const same = buildAnthropicBody({
      ...REQ,
      cacheHints: hints,
      model: 'claude-opus-5-5',
      messages: [REQ.messages[0], msg],
    }) as Record<string, any>;
    expect(same.messages[1].content).toEqual(content);
    expect(same.messages[1].content).not.toBe(content);
    const other = buildAnthropicBody({
      ...REQ,
      cacheHints: hints,
      model: 'claude-haiku-4-5',
      messages: [REQ.messages[0], msg],
    }) as Record<string, any>;
    expect(other.messages[1].content).toEqual([{ type: 'text', text: 'hi' }]);
  });

  it('sends the key only as a header and maps HTTP errors (no network: injected fetch)', async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const ok = createAnthropicProvider({
      apiKey: TEST_KEY,
      fetch: (async (url: string, init: RequestInit) => {
        seen = { url, init };
        return new Response(
          JSON.stringify({ content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn', usage: {} }),
        );
      }) as typeof fetch,
    });
    const r = await ok.complete(REQ);
    expect(r.text).toBe('hi');
    expect(seen!.url).toBe('https://api.anthropic.com/v1/messages');
    expect((seen!.init.headers as Record<string, string>)['x-api-key']).toBe(TEST_KEY);
    expect((seen!.init.headers as Record<string, string>)['anthropic-version']).toBe('2023-06-01');
    expect(String(seen!.init.body)).not.toContain('sk-ant');
    const bad = createAnthropicProvider({
      apiKey: 'k',
      fetch: (async () =>
        new Response('{"error":"overloaded"}', {
          status: 529,
          headers: { 'retry-after': '2' },
        })) as typeof fetch,
    });
    const err = await bad.complete(REQ).catch((e) => e);
    expect(err).toBeInstanceOf(LlmHttpError);
    expect(err.status).toBe(529);
    expect(err.retryAfterMs).toBe(2000);
  });
});

describe('openai and bedrock adapters', () => {
  it('openai: Responses API function tools, round-trip of tool calls and results', () => {
    const body = buildOpenAiBody({ ...REQ, model: 'gpt-5' }) as Record<string, any>;
    expect(body.instructions).toBe('SYSTEM');
    expect(body.tools[0]).toMatchObject({ type: 'function', name: 'get_x' });
    expect(body.input).toContainEqual({
      type: 'function_call',
      call_id: 't1',
      name: 'get_x',
      arguments: '{"a":1}',
    });
    expect(body.input).toContainEqual({
      type: 'function_call_output',
      call_id: 't1',
      output: '<tool_result>1</tool_result>',
    });
    expect(body.temperature).toBeUndefined();
    const r = parseOpenAiResponse(
      {
        status: 'completed',
        output: [
          { type: 'message', content: [{ type: 'output_text', text: 'Thinking.' }] },
          { type: 'function_call', call_id: 'c1', name: 'report', arguments: '{"summary":"x"}' },
        ],
        usage: { input_tokens: 120, output_tokens: 7, input_tokens_details: { cached_tokens: 100 } },
      },
      'gpt-5',
    );
    expect(r.toolCalls).toEqual([{ id: 'c1', name: 'report', input: { summary: 'x' } }]);
    expect(r.usage).toEqual({ inputTokens: 20, outputTokens: 7, cacheReadTokens: 100, cacheWriteTokens: 0 });
    expect(r.stopReason).toBe('tool_use');
  });

  it('bedrock: Converse toolConfig and output parsing (injected send, no SDK load)', async () => {
    const input = buildConverseInput(REQ) as Record<string, any>;
    expect(input.toolConfig.tools[0].toolSpec.inputSchema.json).toEqual({ type: 'object', properties: {} });
    expect(input.messages[2].content[0].toolResult.status).toBe('error');
    const p = createBedrockProvider({
      send: async () => ({
        output: {
          message: { content: [{ text: 'hi' }, { toolUse: { toolUseId: 'b1', name: 'report', input: {} } }] },
        },
        stopReason: 'tool_use',
        usage: { inputTokens: 3, outputTokens: 4 },
      }),
    });
    const r = await p.complete(REQ);
    expect(r.toolCalls[0].id).toBe('b1');
    expect(parseConverseOutput({ stopReason: 'end_turn' }, 'm').stopReason).toBe('end_turn');
  });
});

describe('retry, router and replay', () => {
  it('withRetry retries 429/5xx up to 4 attempts, not 4xx', async () => {
    const clock = new VirtualClock();
    let n = 0;
    await expect(
      withRetry(
        async () => {
          n++;
          throw new LlmHttpError('x', 503, '');
        },
        { clock },
      ),
    ).rejects.toThrow(/503/);
    expect(n).toBe(4);
    n = 0;
    await expect(
      withRetry(
        async () => {
          n++;
          throw new LlmHttpError('x', 400, '');
        },
        { clock },
      ),
    ).rejects.toThrow(/400/);
    expect(n).toBe(1);
  });

  it('router: two 5xx from the primary → fallback, reported once', async () => {
    const clock = new VirtualClock();
    const falls: string[] = [];
    const router = new LlmRouter({
      config: {
        provider: 'anthropic',
        model: 'a',
        fallback: { provider: 'openai', model: 'b' },
        temperature: 0.2,
        maxTokens: 10,
        limits: {} as never,
      },
      deps: {
        providers: {
          anthropic: createScriptedProvider(() => ({ error: new LlmHttpError('anthropic', 500, '') }), {
            id: 'anthropic',
          }),
          openai: createScriptedProvider(() => ({ text: 'fine' }), { id: 'openai' }),
        },
      },
      clock,
      onFallback: async (from, to) => void falls.push(`${from.model}->${to.model}`),
    });
    const r1 = await router.complete({ ...REQ });
    expect(r1).toMatchObject({ provider: 'openai', model: 'b' });
    await router.complete({ ...REQ });
    expect(falls).toEqual(['a->b']);
    expect(router.usingFallback).toBe(true);
  });

  it('replay returns recorded responses by (agentPath, iteration); misses fail loudly', async () => {
    const p = createReplayProvider([
      {
        kind: 'llm',
        runId: 'r',
        agentRunId: 'a',
        agentPath: 'orchestrator',
        role: 'orchestrator',
        iteration: 0,
        provider: 'anthropic',
        model: 'm',
        latencyMs: 5,
        request: REQ,
        response: {
          text: 'rec',
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
          stopReason: 'end_turn',
          model: 'm',
        },
      },
    ]);
    const meta = {
      runId: 'r',
      agentRunId: 'x',
      role: 'orchestrator' as const,
      iteration: 0,
      agentPath: 'orchestrator',
    };
    expect((await p.complete({ ...REQ, meta })).text).toBe('rec');
    await expect(p.complete({ ...REQ, meta: { ...meta, iteration: 1 } })).rejects.toThrow(
      /no recorded response for orchestrator#1/,
    );
    expect(traceFileName('orchestrator/maintenance.1', 3)).toBe('orchestrator_maintenance.1__003.json');
  });
});

describe('config, pricing and redaction', () => {
  it('rejects temperatures above 0.2 and reads limits from env', () => {
    expect(() => assertTemperature(0.3)).toThrow(/0.2/);
    expect(() => llmConfigFromEnv({ LLM_TEMPERATURE: '0.5' })).toThrow(/NFR-03/);
    const c = llmConfigFromEnv({
      LLM_MODEL: 'claude-haiku-4-5',
      RUN_BUDGET_USD: '0.5',
      RUN_HORIZON_MIN: '60',
      LLM_FALLBACK_PROVIDER: 'openai',
      LLM_FALLBACK_MODEL: 'gpt-5',
    });
    expect(c).toMatchObject({
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      temperature: 0.2,
      fallback: { provider: 'openai', model: 'gpt-5' },
    });
    expect(c.limits.budgetUsd).toBe(0.5);
    expect(c.limits.horizonMin).toBe(60);
    expect(llmConfigFromEnv({}).model).toBe('claude-sonnet-5-5');
  });

  it('computes cost including cache reads and writes', () => {
    // Sonnet 5: $2 in, $10 out, $0.2 cache read, $2.5 cache write per MTok
    expect(
      costUsd('claude-sonnet-5', {
        inputTokens: 1_000_000,
        outputTokens: 100_000,
        cacheReadTokens: 1_000_000,
        cacheWriteTokens: 1_000_000,
      }),
    ).toBeCloseTo(2 + 1 + 0.2 + 2.5, 8);
    expect(worstCaseUsd('claude-sonnet-5', 1_000_000, 0)).toBeCloseTo(2.5, 8);
    expect(priceFor('unknown-model').input).toBeGreaterThanOrEqual(priceFor('claude-opus-5-5').input);
  });

  it('redacts API keys', () => {
    // Fake keys are assembled at runtime so no key-shaped literal lives in the source (secret scanners).
    const fakeAnthropic = ['sk', 'ant', 'api03', 'abcdefghijk'].join('-');
    const fakeAws = 'AKIA' + 'ABCDEFGHIJKLMNOP';
    expect(redact(`key ${fakeAnthropic} and ${fakeAws}`)).toBe('key [REDACTED] and [REDACTED]');
  });
});
