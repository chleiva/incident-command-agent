/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import { type InvokeCommand } from '@aws-sdk/client-lambda';
import { describe, expect, it } from 'vitest';
import { LambdaAuthorInvoker, LambdaRunLauncher } from '../runner/launchers';
import { DEFAULT_BRAND, parseBrandPack, parseStations, selectStations } from './app-config';
import { llmConfigFromEnv, settingsFromEnv } from './settings';

describe('settings', () => {
  it('parses LLM config with fallback and limits, and rejects temperature above 0.2', () => {
    const cfg = llmConfigFromEnv({
      LLM_PROVIDER: 'openai',
      LLM_MODEL: 'm',
      LLM_FALLBACK_PROVIDER: 'bedrock',
      LLM_FALLBACK_MODEL: 'fb',
      RUN_BUDGET_USD: '0.5',
      RUN_HORIZON_MIN: '60',
    });
    expect(cfg).toMatchObject({
      provider: 'openai',
      model: 'm',
      temperature: 0.2,
      fallback: { provider: 'bedrock', model: 'fb' },
    });
    expect(cfg.limits).toMatchObject({ budgetUsd: 0.5, horizonMin: 60, maxIterationsPerAgent: 25 });
    expect(() => llmConfigFromEnv({ LLM_TEMPERATURE: '0.7' })).toThrow(/0.2/);
    expect(() => llmConfigFromEnv({ LLM_PROVIDER: 'mystery' })).toThrow(/LLM_PROVIDER/);
  });

  it('defaults to cognito auth with no CORS origins; none defaults to *', () => {
    expect(settingsFromEnv({})).toMatchObject({ authMode: 'cognito', corsOrigins: [], maxRunsPerDay: 0 }); // 0 = no daily limit;
    expect(settingsFromEnv({ AUTH_MODE: 'none' }).corsOrigins).toEqual(['*']);
    expect(settingsFromEnv({ CORS_ORIGINS: 'https://a, http://localhost:5173' }).corsOrigins).toEqual([
      'https://a',
      'http://localhost:5173',
    ]);
    expect(() => settingsFromEnv({ AUTH_MODE: 'open' })).toThrow();
  });
});

describe('app config', () => {
  it('validates brand packs and stations', () => {
    expect(parseBrandPack(JSON.stringify(DEFAULT_BRAND)).carrierCode).toBe('ACX');
    expect(() => parseBrandPack('{"carrierName":"X"}')).toThrow(/invalid brand pack/);
    const st = parseStations(
      JSON.stringify({ stations: [{ iata: 'ZZZ', name: 'Z', lat: 1, lon: 2, country: 'GB', extra: 1 }] }),
    );
    expect(st).toEqual([{ iata: 'ZZZ', name: 'Z', lat: 1, lon: 2, country: 'GB' }]);
    expect(() => parseStations('[{"iata":"X"}]')).toThrow(/invalid stations/);
  });

  it('selects brand stations first, then scenario stations, dropping unknown codes', () => {
    const all = [{ iata: 'ZZZ', name: 'Z', lat: 1, lon: 2, country: 'GB' }];
    const brand = { ...DEFAULT_BRAND, stations: ['DUB', 'MAN', 'QQQ'] };
    expect(selectStations(all, brand, ['ZZZ', 'MAN', 'ZZZ']).map((s) => s.iata)).toEqual([
      'DUB',
      'MAN',
      'ZZZ',
    ]);
  });
});

describe('Lambda launchers', () => {
  it('invokes the Run Lambda asynchronously with {runId}', async () => {
    const sent: InvokeCommand[] = [];
    const client = { send: async (c: InvokeCommand) => (sent.push(c), { StatusCode: 202 }) } as never;
    await new LambdaRunLauncher(client, 'run-fn').launch('run-1');
    expect(sent[0].input.InvocationType).toBe('Event');
    expect(sent[0].input.FunctionName).toBe('run-fn');
    expect(JSON.parse(new TextDecoder().decode(sent[0].input.Payload as Uint8Array))).toEqual({
      runId: 'run-1',
    });
    const bad = { send: async () => ({ StatusCode: 500 }) } as never;
    await expect(new LambdaRunLauncher(bad, 'x').launch('r')).rejects.toThrow(/500/);
  });

  it('passes the authoring request in the async Run Lambda payload', async () => {
    const sent: InvokeCommand[] = [];
    const client = { send: async (c: InvokeCommand) => (sent.push(c), { StatusCode: 202 }) } as never;
    await new LambdaRunLauncher(client, 'run-fn').launch('run-2', {
      authoring: { text: 'Leak getting worse', label: 'Hydraulic leak' },
    });
    expect(sent[0].input.InvocationType).toBe('Event');
    expect(JSON.parse(new TextDecoder().decode(sent[0].input.Payload as Uint8Array))).toEqual({
      runId: 'run-2',
      authoring: { text: 'Leak getting worse', label: 'Hydraulic leak' },
    });
  });

  it('invokes the author Lambda asynchronously with {draftId, text}', async () => {
    const sent: InvokeCommand[] = [];
    const ok = { send: async (c: InvokeCommand) => (sent.push(c), { StatusCode: 202 }) } as never;
    await new LambdaAuthorInvoker(ok, 'author-fn').start('draft-1', 'text');
    expect(sent[0].input.InvocationType).toBe('Event');
    expect(sent[0].input.FunctionName).toBe('author-fn');
    expect(JSON.parse(new TextDecoder().decode(sent[0].input.Payload as Uint8Array))).toEqual({
      draftId: 'draft-1',
      text: 'text',
    });
    const bad = { send: async () => ({ StatusCode: 500 }) } as never;
    await expect(new LambdaAuthorInvoker(bad, 'x').start('d', 't')).rejects.toThrow(/500/);
  });
});
