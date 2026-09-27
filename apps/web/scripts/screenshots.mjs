/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Capture the design-review screenshots (fictional data, mock mode) with headless Playwright.
 *   VITE_MOCK=1 npx vite --port 5174   # in another terminal
 *   npm run screenshots -w @ica/web -- --base http://localhost:5174 [--out ../../docs/screenshots] [--only cockpit]
 */
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const base = arg('base', 'http://localhost:5174');
const out = resolve(arg('out', '../../docs/screenshots'));
const only = arg('only', '');
mkdirSync(out, { recursive: true });

const SHOTS = [
  { name: 'cockpit', path: '/runs/run-demo-s01?at=31', wait: '[data-approval]', wide: true },
  { name: 'cockpit-ended', path: '/runs/run-demo-s01', wait: '#run-ended-title', themes: ['light'] },
  {
    name: 'cockpit-s04-options',
    path: '/runs/run-demo-s04?at=15',
    wait: '[data-approval]',
    themes: ['dark'],
  },
  {
    name: 'compare',
    path: '/compare/run-demo-s01/run-demo-s01-baseline?x=1',
    wait: '[aria-label="Deltas versus the baseline"]',
  },
  { name: 'home', path: '/', wait: '[data-scenario]', themes: ['dark'] },
  { name: 'evals', path: '/evals', wait: '#layers-h', themes: ['dark'] },
];
const VIEWPORTS = [
  { w: 1920, h: 1080 },
  { w: 1440, h: 900 },
];
const THEMES = ['dark', 'light'];

const browser = await chromium.launch();
for (const shot of SHOTS.filter((s) => !only || s.name === only)) {
  for (const vp of VIEWPORTS) {
    for (const theme of shot.themes ?? THEMES) {
      if (!shot.wide && vp.w !== 1920) continue;
      const context = await browser.newContext({
        viewport: { width: vp.w, height: vp.h },
        deviceScaleFactor: 1,
        reducedMotion: 'reduce',
      });
      await context.addInitScript((t) => {
        try {
          localStorage.setItem('ica.theme', t);
        } catch {
          /* ignore */
        }
      }, theme);
      const page = await context.newPage();
      await page.goto(`${base}${shot.path}`);
      await page.waitForSelector(shot.wait, { timeout: 20_000 });
      await page.waitForTimeout(600);
      const file = `${out}/${shot.name}-${vp.w}x${vp.h}-${theme}.png`;
      await page.screenshot({ path: file });
      console.log(`captured ${file}`);
      await context.close();
    }
  }
}
await browser.close();
