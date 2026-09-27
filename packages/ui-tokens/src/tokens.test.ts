/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AA_NON_TEXT,
  AA_TEXT,
  ACCENTS,
  BACKGROUND_TOKENS,
  TEXT_TOKENS,
  THEMES,
  colors,
  contrastRatio,
  icaPreset,
  renderFigmaTokens,
  renderTokensCss,
} from './index';
import { GENERATED_FILES, renderGenerated } from './generate';

const pkgDir = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');

describe('WCAG 2.2 AA contrast (every foreground × background pair, both themes)', () => {
  for (const theme of THEMES) {
    const c = colors[theme];
    const foregrounds = [...TEXT_TOKENS, ...ACCENTS] as const;
    for (const fg of foregrounds) {
      for (const bg of BACKGROUND_TOKENS) {
        it(`${theme}: ${fg} on ${bg} ≥ ${AA_TEXT}`, () => {
          expect(contrastRatio(c[fg], c[bg])).toBeGreaterThanOrEqual(AA_TEXT);
        });
      }
    }
    for (const accent of ACCENTS) {
      it(`${theme}: ${accent} and fg on ${accent}-bg ≥ ${AA_TEXT}`, () => {
        expect(contrastRatio(c[accent], c[`${accent}-bg`])).toBeGreaterThanOrEqual(AA_TEXT);
        expect(contrastRatio(c.fg, c[`${accent}-bg`])).toBeGreaterThanOrEqual(AA_TEXT);
        expect(contrastRatio(c['fg-muted'], c[`${accent}-bg`])).toBeGreaterThanOrEqual(AA_TEXT);
      });
      it(`${theme}: on-${accent} on ${accent} ≥ ${AA_TEXT}`, () => {
        expect(contrastRatio(c[`on-${accent}`], c[accent])).toBeGreaterThanOrEqual(AA_TEXT);
      });
    }
    for (const bg of BACKGROUND_TOKENS) {
      it(`${theme}: border-control and focus on ${bg} ≥ ${AA_NON_TEXT} (non-text)`, () => {
        expect(contrastRatio(c['border-control'], c[bg])).toBeGreaterThanOrEqual(AA_NON_TEXT);
        expect(contrastRatio(c.focus, c[bg])).toBeGreaterThanOrEqual(AA_NON_TEXT);
      });
    }
  }
});

describe('token set', () => {
  it('has exactly four accents, and identical token names in both themes', () => {
    expect(ACCENTS).toEqual(['good', 'warning', 'critical', 'ai']);
    expect(Object.keys(colors.light).sort()).toEqual(Object.keys(colors.dark).sort());
  });

  it('renders CSS variables for both themes and reduced motion', () => {
    const css = renderTokensCss();
    expect(css).toContain('[data-theme="light"]');
    expect(css).toContain('--c-fg: 231 237 243;');
    expect(css).toContain('prefers-reduced-motion');
    expect(css).toContain('--duration-base: 200ms;');
  });

  it('exports a Tokens Studio document with both themes', () => {
    const doc = renderFigmaTokens() as { $themes: unknown[]; dark: { color: Record<string, unknown> } };
    expect(doc.$themes).toHaveLength(2);
    expect(doc.dark.color.critical).toEqual({ value: colors.dark.critical, type: 'color' });
  });

  it('maps every colour into the Tailwind preset', () => {
    expect(Object.keys(icaPreset.theme.colors)).toEqual(expect.arrayContaining(Object.keys(colors.dark)));
  });

  it('committed generated files are up to date (run `npm run build -w @ica/ui-tokens`)', async () => {
    const fresh = await renderGenerated(pkgDir);
    for (const f of GENERATED_FILES) {
      expect(readFileSync(`${pkgDir}/${f}`, 'utf8'), f).toBe(fresh[f]);
    }
  });
});
