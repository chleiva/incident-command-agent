/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Tailwind CSS (v3) preset driven by the token CSS variables, so a theme switch is a `data-theme` flip with no
 * rebuild. Usage: `presets: [icaPreset]` in `tailwind.config.ts`, and import `@ica/ui-tokens/tokens.css`.
 */
import { colors, radii, spacing, typography } from './tokens';

const colorNames = Object.keys(colors.dark);
const cssColor = (name: string) => `rgb(var(--c-${name}) / <alpha-value>)`;

export const icaPreset = {
  darkMode: ['selector', '[data-theme="dark"]'] as ['selector', string],
  theme: {
    colors: {
      transparent: 'transparent',
      current: 'currentColor',
      ...Object.fromEntries(colorNames.map((n) => [n, cssColor(n)])),
    },
    spacing: {
      px: '1px',
      ...Object.fromEntries(Object.entries(spacing).map(([k, v]) => [k, `${v}px`])),
    },
    borderRadius: {
      none: '0',
      DEFAULT: `${radii.md}px`,
      ...Object.fromEntries(Object.entries(radii).map(([k, v]) => [k, `${v}px`])),
    },
    fontFamily: {
      sans: ['var(--font-sans)'],
      mono: ['var(--font-mono)'],
    },
    fontSize: Object.fromEntries(
      Object.entries(typography.scale).map(([k, v]) => [
        k,
        [`${v.size}px`, { lineHeight: `${v.lineHeight}px`, letterSpacing: `${v.tracking}em` }] as [
          string,
          { lineHeight: string; letterSpacing: string },
        ],
      ]),
    ),
    boxShadow: { none: 'none', e1: 'var(--shadow-e1)', e2: 'var(--shadow-e2)', e3: 'var(--shadow-e3)' },
    extend: {
      transitionDuration: {
        fast: 'var(--duration-fast)',
        base: 'var(--duration-base)',
        slow: 'var(--duration-slow)',
      },
      transitionTimingFunction: {
        standard: 'var(--ease-standard)',
        emphasized: 'var(--ease-emphasized)',
        exit: 'var(--ease-exit)',
      },
      ringColor: { DEFAULT: cssColor('focus') },
    },
  },
};

export default icaPreset;
