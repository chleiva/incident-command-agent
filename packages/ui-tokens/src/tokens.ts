/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * The design tokens: the single source of truth for colour, type, spacing, radii, elevation and motion.
 * `tokens.css`, the Tailwind preset and `figma-tokens.json` (Tokens Studio) are all generated from this file.
 *
 * Colour rules (spec §4 "calm density"): neutrals plus exactly four accents (good, warning, critical, AI).
 * Accents appear only when a threshold is crossed or when text is AI-drafted. The brand pair (`brand-primary`,
 * `brand-accent`) is identity only (the logo mark) and is overridden at runtime from the brand pack.
 */

export const THEMES = ['dark', 'light'] as const;
export type ThemeName = (typeof THEMES)[number];

/** The four semantic accents. Nothing else in the UI may carry hue. */
export const ACCENTS = ['good', 'warning', 'critical', 'ai'] as const;
export type AccentName = (typeof ACCENTS)[number];

export const BACKGROUND_TOKENS = [
  'bg',
  'surface',
  'surface-raised',
  'surface-sunken',
  'surface-hover',
] as const;
export const TEXT_TOKENS = ['fg', 'fg-muted', 'fg-subtle'] as const;
export type BackgroundToken = (typeof BACKGROUND_TOKENS)[number];
export type TextToken = (typeof TEXT_TOKENS)[number];

export type ColorTokenName =
  | BackgroundToken
  | TextToken
  | 'border'
  | 'border-control'
  | 'focus'
  | 'brand-primary'
  | 'brand-accent'
  | AccentName
  | `${AccentName}-bg`
  | `on-${AccentName}`;

export type ColorScale = Record<ColorTokenName, string>;

export const colors: Record<ThemeName, ColorScale> = {
  /** "Ops room": the default. Low-glare blue-black neutrals; accents tuned for ≥ 4.5:1 on every surface. */
  dark: {
    bg: '#0A0E13',
    surface: '#10161D',
    'surface-raised': '#161E27',
    'surface-sunken': '#0C1117',
    'surface-hover': '#1C2631',
    fg: '#E7EDF3',
    'fg-muted': '#AEBBC8',
    'fg-subtle': '#8A99A9',
    border: '#243140',
    'border-control': '#66778B',
    focus: '#E7EDF3',
    'brand-primary': '#1F3A5F',
    'brand-accent': '#4F8FBF',
    good: '#4CC38A',
    'good-bg': '#0F2A20',
    'on-good': '#0A0E13',
    warning: '#E8A93A',
    'warning-bg': '#2E2310',
    'on-warning': '#0A0E13',
    critical: '#F26B67',
    'critical-bg': '#35161A',
    'on-critical': '#0A0E13',
    ai: '#A594FF',
    'ai-bg': '#221D3D',
    'on-ai': '#0A0E13',
  },
  light: {
    bg: '#F5F7F9',
    surface: '#FFFFFF',
    'surface-raised': '#FFFFFF',
    'surface-sunken': '#EEF1F4',
    'surface-hover': '#E8ECF0',
    fg: '#0E1621',
    'fg-muted': '#3B4856',
    'fg-subtle': '#56636F',
    border: '#D8DEE4',
    'border-control': '#7A8693',
    focus: '#0E1621',
    'brand-primary': '#1F3A5F',
    'brand-accent': '#4F8FBF',
    good: '#17794F',
    'good-bg': '#E3F4EC',
    'on-good': '#FFFFFF',
    warning: '#8F5B00',
    'warning-bg': '#FBF0DC',
    'on-warning': '#FFFFFF',
    critical: '#B42B28',
    'critical-bg': '#FBE7E6',
    'on-critical': '#FFFFFF',
    ai: '#6446D0',
    'ai-bg': '#EEEAFD',
    'on-ai': '#FFFFFF',
  },
};

export type TypeStep = { size: number; lineHeight: number; weight: number; tracking: number };

/** Type scale (px). All figures use tabular numerals (`font-variant-numeric: tabular-nums`). */
export const typography = {
  fontFamily: {
    sans: 'Inter, "Inter var", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    mono: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
  },
  scale: {
    micro: { size: 11, lineHeight: 16, weight: 500, tracking: 0.04 },
    caption: { size: 12, lineHeight: 16, weight: 400, tracking: 0 },
    body: { size: 13, lineHeight: 20, weight: 400, tracking: 0 },
    'body-lg': { size: 14, lineHeight: 20, weight: 400, tracking: 0 },
    title: { size: 16, lineHeight: 24, weight: 600, tracking: -0.005 },
    heading: { size: 20, lineHeight: 28, weight: 600, tracking: -0.01 },
    figure: { size: 24, lineHeight: 32, weight: 600, tracking: -0.01 },
    display: { size: 32, lineHeight: 40, weight: 600, tracking: -0.02 },
  } satisfies Record<string, TypeStep>,
};

/** 8-pt grid (4 px half-steps allowed for dense rows). Values in px. */
export const spacing: Record<string, number> = {
  '0': 0,
  '0.5': 2,
  '1': 4,
  '2': 8,
  '3': 12,
  '4': 16,
  '5': 20,
  '6': 24,
  '8': 32,
  '10': 40,
  '7': 28,
  '9': 36,
  '12': 48,
  '14': 56,
  '16': 64,
  '20': 80,
  '24': 96,
  '32': 128,
  '40': 160,
  '48': 192,
  '64': 256,
  '80': 320,
  '96': 384,
};

export const radii: Record<string, number> = { sm: 4, md: 6, lg: 10, xl: 14, full: 9999 };

export type ElevationName = 'e1' | 'e2' | 'e3';

export const elevation: Record<ThemeName, Record<ElevationName, string>> = {
  dark: {
    e1: '0 1px 0 0 rgba(255,255,255,0.03) inset, 0 1px 2px 0 rgba(0,0,0,0.4)',
    e2: '0 1px 0 0 rgba(255,255,255,0.04) inset, 0 4px 12px -2px rgba(0,0,0,0.55)',
    e3: '0 1px 0 0 rgba(255,255,255,0.05) inset, 0 16px 40px -8px rgba(0,0,0,0.7)',
  },
  light: {
    e1: '0 1px 2px 0 rgba(14,22,33,0.06)',
    e2: '0 4px 12px -2px rgba(14,22,33,0.10)',
    e3: '0 16px 40px -8px rgba(14,22,33,0.18)',
  },
};

/** Motion only for state change (spec §4): 150–300 ms; reduced motion collapses to 0. */
export const motion = {
  duration: { fast: 150, base: 200, slow: 300 },
  easing: {
    standard: 'cubic-bezier(0.2, 0, 0, 1)',
    emphasized: 'cubic-bezier(0.3, 0, 0, 1)',
    exit: 'cubic-bezier(0.4, 0, 1, 1)',
  },
} as const;

/** Numeric bezier arrays (for Framer Motion). */
export const motionEase = {
  standard: [0.2, 0, 0, 1] as [number, number, number, number],
  emphasized: [0.3, 0, 0, 1] as [number, number, number, number],
  exit: [0.4, 0, 1, 1] as [number, number, number, number],
};

/** Everything, as one constants object. */
export const tokens = { colors, typography, spacing, radii, elevation, motion, motionEase } as const;
