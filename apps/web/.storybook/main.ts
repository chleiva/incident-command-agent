/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import type { StorybookConfig } from '@storybook/react-vite';

const config: StorybookConfig = {
  stories: ['../src/**/*.stories.@(ts|tsx)'],
  addons: ['@storybook/addon-a11y'],
  framework: { name: '@storybook/react-vite', options: {} },
  core: { disableTelemetry: true },
  async viteFinal(cfg) {
    // The app's manual chunking and bundle budget are for the SPA build only.
    const out = cfg.build?.rollupOptions?.output;
    if (out && !Array.isArray(out)) delete out.manualChunks;
    cfg.plugins = (cfg.plugins ?? []).filter(
      (p) => !(p && typeof p === 'object' && 'name' in p && p.name === 'ica-bundle-budget'),
    );
    cfg.build = { ...cfg.build, chunkSizeWarningLimit: 4_000 };
    return cfg;
  },
};

export default config;
