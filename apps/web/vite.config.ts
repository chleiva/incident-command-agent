/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/// <reference types="vitest/config" />
import { execSync } from 'node:child_process';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

/** Short git commit shown in the About dialog ("dev" outside a git checkout). */
function appCommit(): string {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return 'dev';
  }
}

/** Bundle-size budget (spec §4 performance): warn when the initial JS or any chunk grows past the budget. */
const BUDGET_KB = { entry: 260, chunk: 320, pdf: 480 };

function bundleBudget(): Plugin {
  return {
    name: 'ica-bundle-budget',
    apply: 'build',
    generateBundle(_opts, bundle) {
      for (const [name, out] of Object.entries(bundle)) {
        if (out.type !== 'chunk') continue;
        const kb = Buffer.byteLength(out.code) / 1024;
        const limit = out.isEntry ? BUDGET_KB.entry : out.name === 'pdf' ? BUDGET_KB.pdf : BUDGET_KB.chunk;
        if (kb > limit) this.warn(`bundle budget: ${name} is ${kb.toFixed(0)} kB (budget ${limit} kB)`);
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), bundleBudget()],
  define: { __APP_COMMIT__: JSON.stringify(process.env.APP_COMMIT ?? appCommit()) },
  server: { port: 5173, strictPort: false },
  // Crawl the lazy routes and the mock backend up front, so a cold dev server never reloads mid-session to
  // optimise a newly discovered dependency (that would drop the in-browser mock backend's runs).
  optimizeDeps: {
    entries: [
      'index.html',
      'src/routes/*.tsx',
      'src/mocks/services.ts',
      'src/lib/evidencePdf.ts',
      'src/lib/auth.ts',
    ],
    include: ['pdf-lib', 'oidc-client-ts'],
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    // Per-chunk budgets are enforced by the plugin above; the lazy PDF chunk is the largest.
    chunkSizeWarningLimit: BUDGET_KB.pdf,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          motion: ['framer-motion'],
          pdf: ['pdf-lib'],
          radix: ['@radix-ui/react-dialog', '@radix-ui/react-tabs', '@radix-ui/react-tooltip'],
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}', 'scripts/**/*.test.ts'],
    css: false,
  },
});
