/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Config } from 'tailwindcss';
import { icaPreset } from '@ica/ui-tokens/tailwind';

export default {
  presets: [icaPreset],
  content: ['./index.html', './src/**/*.{ts,tsx}', './.storybook/**/*.{ts,tsx}'],
} satisfies Config;
