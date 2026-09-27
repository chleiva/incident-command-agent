/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fixtureScenario } from '../systems/testing';
import { allowedUrl } from './web_search';
import { call, fixtureHarness, okData } from './_testing';

describe('author tools', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('validate_scenario accepts a valid fresh scenario and reports errors otherwise', async () => {
    const h = await fixtureHarness();
    const s = fixtureScenario();
    s.id = 'authored-cargo-door';
    expect(okData(await call(h, 'validate_scenario', { scenario: s }, { role: 'author' }))).toMatchObject({
      valid: true,
    });
    const bad = { ...s, aircraft: { ...s.aircraft, tail: 'G-ABCD' } };
    const r = okData(await call(h, 'validate_scenario', { scenario: bad }, { role: 'author' }));
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toMatch(/\/aircraft\/tail/);
    const shipped = { ...s, id: 's01-pushback-tug-contact' };
    expect(
      okData(await call(h, 'validate_scenario', { scenario: shipped }, { role: 'author' })).errors[0],
    ).toMatch(/reserved/);
  });

  it('validate_scenario only accepts inspiredBy ids present in the precedent corpus', async () => {
    const h = await fixtureHarness();
    const s = fixtureScenario();
    s.id = 'authored-towbar';
    s.inspiredBy = [
      {
        sourceId: 'ASRS ACN 1577181',
        url: 'https://huggingface.co/datasets/elihoole/asrs-aviation-reports',
        note: 'towbar pin sheared',
      },
    ];
    expect(okData(await call(h, 'validate_scenario', { scenario: s }, { role: 'author' })).valid).toBe(true);
    s.inspiredBy = [
      {
        sourceId: 'ASRS ACN 9999999',
        url: 'https://huggingface.co/datasets/elihoole/asrs-aviation-reports',
        note: 'made up',
      },
    ];
    const r = okData(await call(h, 'validate_scenario', { scenario: s }, { role: 'author' }));
    expect(r.errors[0]).toMatch(/not in the precedent corpus/);
  });

  it('lookup_airport by IATA and by name', async () => {
    const h = await fixtureHarness();
    expect(okData(await call(h, 'lookup_airport', { query: 'fao' })).matches[0]).toMatchObject({
      iata: 'FAO',
      country: 'PT',
    });
    const m = okData(await call(h, 'lookup_airport', { query: 'Manchester' })).matches;
    expect(m.map((x: any) => x.iata)).toContain('MAN');
  });

  it('search_precedents returns ASRS narratives with the NASA disclaimer note', async () => {
    const h = await fixtureHarness();
    const out = await call(h, 'search_precedents', { query: 'tow bar pin sheared during pushback' });
    expect(out.ok && out.data.note).toMatch(/unverified/);
    expect(out.ok && out.citations![0].sourceId).toMatch(/^ASRS ACN \d+$/);
  });

  it('web_search is off unless enabled and configured; allow-list enforced', async () => {
    const h = await fixtureHarness();
    vi.stubEnv('FEATURE_WEB_SEARCH', 'false');
    expect(await call(h, 'web_search', { query: 'pushback towbar' })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/disabled/),
    });
    vi.stubEnv('FEATURE_WEB_SEARCH', 'true');
    vi.stubEnv('TAVILY_API_KEY', '');
    vi.stubEnv('BRAVE_API_KEY', '');
    expect(await call(h, 'web_search', { query: 'pushback towbar' })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/not configured/),
    });
    expect(allowedUrl('https://www.gov.uk/aaib-reports/x')).toBe(true);
    expect(allowedUrl('https://safetyfirst.airbus.com/lightning-strikes/')).toBe(true);
    expect(allowedUrl('https://evil.example.com/gov.uk')).toBe(false);
    expect(allowedUrl('https://notgov.uk.example.com')).toBe(false);
  });
});
