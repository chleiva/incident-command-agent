/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Tokens Studio (Figma plugin) export: `figma-tokens.json`. Import it in Figma with Tokens Studio → Load from file.
 * Sets: `global` (type, spacing, radii, motion), `dark`, `light`; two themes enabling `global` + one colour set.
 */
import { colors, elevation, motion, radii, spacing, typography, type ThemeName } from './tokens';

type Token = { value: string | number | Record<string, string>; type: string; description?: string };
type TokenGroup = { [k: string]: Token | TokenGroup };

function colorSet(theme: ThemeName): TokenGroup {
  const out: TokenGroup = { color: {} };
  for (const [name, hex] of Object.entries(colors[theme])) {
    (out.color as TokenGroup)[name] = { value: hex, type: 'color' };
  }
  out.shadow = Object.fromEntries(
    Object.entries(elevation[theme]).map(([k, v]) => [
      k,
      { value: v, type: 'other', description: 'CSS box-shadow' },
    ]),
  );
  return out;
}

function globalSet(): TokenGroup {
  return {
    fontFamily: {
      sans: { value: 'Inter', type: 'fontFamilies' },
      mono: { value: 'JetBrains Mono', type: 'fontFamilies' },
    },
    typography: Object.fromEntries(
      Object.entries(typography.scale).map(([k, v]) => [
        k,
        {
          type: 'typography',
          value: {
            fontFamily: '{fontFamily.sans}',
            fontWeight: String(v.weight),
            fontSize: `${v.size}`,
            lineHeight: `${v.lineHeight}`,
            letterSpacing: `${v.tracking * 100}%`,
          },
        },
      ]),
    ),
    spacing: Object.fromEntries(
      Object.entries(spacing).map(([k, v]) => [k.replace('.', '_'), { value: v, type: 'spacing' }]),
    ),
    borderRadius: Object.fromEntries(
      Object.entries(radii).map(([k, v]) => [k, { value: v, type: 'borderRadius' }]),
    ),
    duration: Object.fromEntries(
      Object.entries(motion.duration).map(([k, v]) => [k, { value: `${v}ms`, type: 'other' }]),
    ),
    easing: Object.fromEntries(
      Object.entries(motion.easing).map(([k, v]) => [k, { value: v, type: 'other' }]),
    ),
  };
}

export function renderFigmaTokens(): Record<string, unknown> {
  return {
    global: globalSet(),
    dark: colorSet('dark'),
    light: colorSet('light'),
    $themes: [
      { id: 'dark', name: 'Dark (ops room)', selectedTokenSets: { global: 'source', dark: 'enabled' } },
      { id: 'light', name: 'Light', selectedTokenSets: { global: 'source', light: 'enabled' } },
    ],
    $metadata: { tokenSetOrder: ['global', 'dark', 'light'] },
  };
}
