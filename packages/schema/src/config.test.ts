/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BrandPackSchema, CARRIER, compileSchema } from './index';

const read = (p: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../../${p}`, import.meta.url)), 'utf8'));

describe('config/', () => {
  it('brand.default.json is a valid BrandPack for the fictional carrier', () => {
    const brand = read('config/brand.default.json');
    const r = compileSchema(BrandPackSchema)(brand);
    expect(r.ok ? [] : r.errors).toEqual([]);
    expect(brand.carrierName).toBe(CARRIER.name);
    expect(brand.carrierCode).toBe(CARRIER.code);
    expect(brand.disclaimer).toBe('Simulated systems · fictional carrier');
  });

  it('brand.local.example.json is a valid BrandPack', () => {
    expect(compileSchema(BrandPackSchema)(read('config/brand.local.example.json')).ok).toBe(true);
  });

  it('pricing.json prices every required model with all four rates', () => {
    const pricing = read('config/pricing.json');
    expect(pricing.verifiedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(pricing.gbpUsdRate).toBeGreaterThan(1);
    for (const m of ['claude-sonnet-5', 'claude-opus-5-5', 'claude-haiku-4-5']) {
      const p = pricing.models[m];
      for (const k of ['input', 'output', 'cacheRead', 'cacheWrite'])
        expect(typeof p[k], `${m}.${k}`).toBe('number');
    }
    const providers = Object.values(pricing.models as Record<string, { provider: string }>).map(
      (m) => m.provider,
    );
    expect(providers).toEqual(expect.arrayContaining(['anthropic', 'openai', 'bedrock']));
  });

  it('evals/ledger.json starts at the £10 lifetime cap', () => {
    const ledger = read('evals/ledger.json');
    expect(ledger.lifetimeCapGbp).toBe(10);
    expect(Array.isArray(ledger.entries)).toBe(true);
  });
});
