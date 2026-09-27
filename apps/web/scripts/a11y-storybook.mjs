/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Runs axe-core (WCAG 2.2 A/AA rules) over every story of the built Storybook, in both themes, and fails on any
 * violation. Build first: `npm run build-storybook -w @ica/web`, then `npm run storybook:a11y -w @ica/web`.
 *   --filter <prefix>   only stories whose title starts with the prefix (e.g. "Zones/")
 */
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { extname, join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const require = createRequire(import.meta.url);
const root = resolve('storybook-static');
if (!existsSync(join(root, 'index.json'))) {
  console.error('storybook-static/index.json not found: run `npm run build-storybook -w @ica/web` first.');
  process.exit(2);
}
const args = process.argv.slice(2);
const filter = args.includes('--filter') ? args[args.indexOf('--filter') + 1] : '';
const axeSource = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
};
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let file = join(root, path === '/' ? 'index.html' : path);
  if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory())
    file = join(root, 'index.html');
  res.setHeader('content-type', TYPES[extname(file)] ?? 'application/octet-stream');
  createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const index = JSON.parse(readFileSync(join(root, 'index.json'), 'utf8'));
const stories = Object.values(index.entries).filter(
  (e) => e.type === 'story' && (!filter || e.title.startsWith(filter)),
);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
let failures = 0;
for (const theme of ['dark', 'light']) {
  for (const s of stories) {
    await page.goto(`http://localhost:${port}/iframe.html?id=${s.id}&viewMode=story&globals=theme:${theme}`);
    await page.waitForSelector('#storybook-root > *', { timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(250);
    await page.addScriptTag({ content: axeSource });
    // The Storybook a11y addon may be running its own pass: retry until axe is free.
    let violations = [];
    for (let attempt = 0; ; attempt++) {
      try {
        violations = await page.evaluate(async () => {
          const r = await globalThis.axe.run(globalThis.document.body, {
            runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
          });
          return r.violations.map((v) => ({
            id: v.id,
            impact: v.impact,
            nodes: v.nodes.slice(0, 3).map((n) => n.target.join(' ')),
          }));
        });
        break;
      } catch (e) {
        if (attempt > 20 || !String(e).includes('already running')) throw e;
        await page.waitForTimeout(250);
      }
    }
    if (violations.length) {
      failures += 1;
      console.log(`✗ [${theme}] ${s.title} › ${s.name}`);
      for (const v of violations) console.log(`    ${v.id} (${v.impact}): ${v.nodes.join(' | ')}`);
    }
  }
}
await browser.close();
server.close();
console.log(`${stories.length} stories × 2 themes checked; ${failures} with violations.`);
process.exit(failures ? 1 : 0);
