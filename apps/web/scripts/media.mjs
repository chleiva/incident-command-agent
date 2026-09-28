/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * The README media, recorded from mock mode (fictional carrier, simulated systems, no network, no keys):
 *   npm run gifs          → docs/media/<clip>.gif + <clip>.mp4 (Playwright screencast → two-pass ffmpeg palette)
 *   npm run screenshots   → docs/media/<name>.png (palette-quantised)
 *
 *   node scripts/media.mjs [--gifs] [--pngs] [--only hero,audit] [--base http://localhost:5176] [--keep-frames]
 *
 * It starts its own Vite mock server (VITE_MOCK=1) unless --base is given. Deterministic by construction: a fixed
 * viewport (1440×900), dark theme, the browser clock pinned to a fixed date (so the fictional day's schedule is
 * the same on every run), auto-approval off, and scripted pointer moves drawn by a small overlay cursor.
 * Needs ffmpeg on PATH (or FFMPEG=/path/to/ffmpeg). Each GIF is checked against its size budget; if it is over,
 * it is re-encoded at a lower frame rate and width until it fits.
 */
/* global document, addEventListener -- in-page functions run in the browser */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(WEB_DIR, '../../docs/media');
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const VIEWPORT = { width: 1440, height: 900 };
/** The browser's clock starts here: the fictional day's schedule depends on the UTC date. */
const FIXED_TIME = new Date('2026-06-16T11:58:00Z');
const MB = 1024 * 1024;

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const has = (name) => args.includes(`--${name}`);
const only = (arg('only', '') || '').split(',').filter(Boolean);
const wantGifs = has('gifs') || !has('pngs');
const wantPngs = has('pngs') || !has('gifs');
const keepFrames = has('keep-frames');

// ------------------------------------------------------------------------------------------ helpers

function ffmpeg(argv) {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...argv], { stdio: 'inherit' });
  if (r.error) throw new Error(`ffmpeg not found (${FFMPEG}): ${r.error.message}`);
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${argv.join(' ')}`);
}

const size = (file) => statSync(file).size;
const fmt = (bytes) => `${(bytes / MB).toFixed(2)} MB`;

async function startServer() {
  const port = Number(arg('port', '5176'));
  const base = `http://localhost:${port}`;
  const child = spawn('npx', ['vite', '--port', String(port), '--strictPort'], {
    cwd: WEB_DIR,
    env: { ...process.env, VITE_MOCK: '1' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(base)).ok) return { base, stop: () => child.kill('SIGTERM') };
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  child.kill('SIGTERM');
  throw new Error(`the Vite mock server did not start on ${base}`);
}

/** A small arrow cursor and a click ring, drawn in the page (headless Chromium renders no pointer). */
function cursorOverlay() {
  const install = () => {
    if (document.getElementById('__media-cursor')) return;
    const style = document.createElement('style');
    style.textContent =
      '#__media-cursor{position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;' +
      'transform:translate(-80px,-80px);filter:drop-shadow(0 1px 2px rgba(0,0,0,.6))}' +
      '.__media-ring{position:fixed;z-index:2147483646;pointer-events:none;width:34px;height:34px;margin:-17px 0 0 -17px;' +
      'border-radius:50%;border:2px solid rgba(125,211,252,.95);animation:__media-ring .45s ease-out forwards}' +
      '@keyframes __media-ring{from{transform:scale(.4);opacity:1}to{transform:scale(1.25);opacity:0}}';
    document.documentElement.appendChild(style);
    const c = document.createElement('div');
    c.id = '__media-cursor';
    c.innerHTML =
      '<svg width="22" height="24" viewBox="0 0 22 24" xmlns="http://www.w3.org/2000/svg">' +
      '<path d="M3 2v17l4.4-4.1 3.1 6.8 2.9-1.3-3.1-6.7H16z" fill="#fff" stroke="#0b1220" ' +
      'stroke-width="1.4" stroke-linejoin="round"/></svg>';
    document.documentElement.appendChild(c);
    addEventListener(
      'mousemove',
      (e) => (c.style.transform = `translate(${e.clientX - 3}px,${e.clientY - 2}px)`),
      true,
    );
    addEventListener(
      'mousedown',
      (e) => {
        const r = document.createElement('div');
        r.className = '__media-ring';
        r.style.left = `${e.clientX}px`;
        r.style.top = `${e.clientY}px`;
        document.documentElement.appendChild(r);
        setTimeout(() => r.remove(), 600);
      },
      true,
    );
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install);
  else install();
}

async function newPage(browser) {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    colorScheme: 'dark',
    reducedMotion: 'no-preference',
  });
  await context.addInitScript(() => {
    try {
      localStorage.setItem('ica.theme', 'dark');
      localStorage.setItem('ica.autoApprove.v2', 'off');
    } catch {
      /* ignore */
    }
  });
  await context.addInitScript(cursorOverlay);
  const page = await context.newPage();
  await page.clock.install({ time: FIXED_TIME });
  await page.clock.resume();
  page.__pos = { x: VIEWPORT.width * 0.62, y: VIEWPORT.height * 0.55 };
  return page;
}

const pause = (page, ms) => page.waitForTimeout(ms);

/** Glide the pointer to (x, y) with an ease-in-out curve. */
async function glide(page, x, y, ms = 550) {
  const from = page.__pos;
  const steps = Math.max(6, Math.round(ms / 16));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
    await page.mouse.move(from.x + (x - from.x) * e, from.y + (y - from.y) * e);
    await page.waitForTimeout(16);
  }
  page.__pos = { x, y };
}

async function pointAt(page, locator, { dx = 0.5, dy = 0.5, ms } = {}) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) throw new Error(`no bounding box for ${locator}`);
  await glide(page, box.x + box.width * dx, box.y + box.height * dy, ms);
}

async function click(page, locator, opts) {
  await pointAt(page, locator, opts);
  await page.waitForTimeout(120);
  await page.mouse.down();
  await page.waitForTimeout(60);
  await page.mouse.up();
}

async function command(page, text) {
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByRole('dialog').waitFor();
  await pause(page, 250);
  await page.keyboard.type(text, { delay: 45 });
  await pause(page, 450);
  await page.keyboard.press('Enter');
}

/** Screencast frames (PNG, wall-clock timestamps) between start() and stop(). */
async function recorder(page) {
  const cdp = await page.context().newCDPSession(page);
  const frames = [];
  let startedAt = 0;
  cdp.on('Page.screencastFrame', async ({ data, metadata, sessionId }) => {
    frames.push({ t: metadata.timestamp, data });
    try {
      await cdp.send('Page.screencastFrameAck', { sessionId });
    } catch {
      /* stopped */
    }
  });
  return {
    async start() {
      startedAt = Date.now() / 1000;
      await cdp.send('Page.startScreencast', {
        format: 'png',
        maxWidth: VIEWPORT.width,
        maxHeight: VIEWPORT.height,
        everyNthFrame: 1,
      });
    },
    async stop() {
      const stoppedAt = Date.now() / 1000;
      await cdp.send('Page.stopScreencast');
      await cdp.detach();
      return { frames, startedAt, stoppedAt };
    },
  };
}

/** Write the frames and an ffmpeg concat list with each frame's real duration. */
function writeFrames({ frames, stoppedAt }, dir) {
  if (!frames.length) throw new Error('no frames were captured');
  const lines = [];
  frames.forEach((f, i) => {
    const file = join(dir, `f${String(i).padStart(5, '0')}.png`);
    writeFileSync(file, Buffer.from(f.data, 'base64'));
    const next = i + 1 < frames.length ? frames[i + 1].t : stoppedAt;
    lines.push(`file '${file}'`, `duration ${Math.max(0.001, next - f.t).toFixed(4)}`);
  });
  // The concat demuxer ignores the last duration unless the last file is repeated.
  lines.push(lines[lines.length - 2]);
  const list = join(dir, 'frames.txt');
  writeFileSync(list, `${lines.join('\n')}\n`);
  return list;
}

function encode(list, clip, dir) {
  const crop = clip.crop ? `crop=${clip.crop.join(':')},` : '';
  const srcWidth = clip.crop ? clip.crop[0] : VIEWPORT.width;
  const gif = join(OUT, `${clip.name}.gif`);
  const mp4 = join(OUT, `${clip.name}.mp4`);
  const tries = [
    { fps: 15, width: Math.min(1280, srcWidth) },
    { fps: 12, width: Math.min(1280, srcWidth) },
    { fps: 12, width: Math.min(1120, srcWidth) },
    { fps: 10, width: Math.min(1024, srcWidth) },
    { fps: 10, width: Math.min(900, srcWidth) },
    { fps: 8, width: Math.min(800, srcWidth) },
  ];
  let used = tries[0];
  for (const t of tries) {
    used = t;
    const vf = `fps=${t.fps},${crop}scale=${t.width}:-1:flags=lanczos`;
    const palette = join(dir, 'palette.png');
    // Pass 1: one palette for the whole clip, weighted towards what changes.
    ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-vf', `${vf},palettegen=stats_mode=diff`, palette]);
    // Pass 2: map every frame to it; only the changed rectangle of each frame is re-dithered.
    ffmpeg([
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      list,
      '-i',
      palette,
      '-lavfi',
      `${vf}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`,
      '-loop',
      '0',
      gif,
    ]);
    if (size(gif) <= clip.budget) break;
    console.log(
      `  ${clip.name}.gif is ${fmt(size(gif))} at ${t.fps} fps/${t.width} px; over budget, retrying`,
    );
  }
  const mp4Width = Math.min(1280, srcWidth) - (Math.min(1280, srcWidth) % 2);
  ffmpeg([
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    list,
    '-vf',
    `fps=30,${crop}scale=${mp4Width}:-2:flags=lanczos,format=yuv420p`,
    '-c:v',
    'libx264',
    '-preset',
    'slow',
    '-crf',
    '22',
    '-movflags',
    '+faststart',
    '-an',
    mp4,
  ]);
  const ok = size(gif) <= clip.budget;
  console.log(
    `${ok ? '✓' : '✗'} ${clip.name}.gif ${fmt(size(gif))} (${used.fps} fps, ${used.width} px, budget ${fmt(clip.budget)})` +
      ` · ${clip.name}.mp4 ${fmt(size(mp4))}`,
  );
  return ok;
}

// ------------------------------------------------------------------------------------------ shared flows

/** Home at 12:00 (network clock): the "On ground" filter and a Manchester departure that is boarding. */
async function openManDeparture(page, base, rec) {
  await page.goto(`${base}/?at=12:00${rec ? '&timescale=1.4' : ''}`);
  await page.waitForSelector('[data-testid="network-map"] canvas');
  await pause(page, 1200);
  await rec?.start();
  await pause(page, 1300);
  await click(page, page.getByRole('button', { name: 'On ground', exact: true }));
  await pause(page, 500);
  const flight = page
    .getByRole('listbox', { name: 'Flights' })
    .getByRole('option')
    .filter({ hasText: /MAN→[\s\S]*Boarding/ })
    .first();
  await click(page, flight, { dx: 0.3 });
  await page.getByTestId('flight-panel').waitFor();
  await pause(page, 1300);
}

/** Start a training scenario (the Training page), with the run speed set. */
async function startTraining(page, base, title, { speed = '30', query = '' } = {}) {
  await page.goto(`${base}/training${query}`);
  await page.waitForSelector('[data-scenario]');
  await page.getByLabel('Speed').selectOption(speed);
  await page.getByRole('button', { name: `Start ${title}` }).click();
  await page.getByTestId('kpi-value-cost').waitFor({ timeout: 15_000 });
}

const S01 = 'Towbar shear and nose-gear contact on pushback';
const S04 = 'Lightning strike at outstation, no licensed engineer on site';

// ------------------------------------------------------------------------------------------ clips

const CLIPS = [
  {
    // Map → a flight → Report incident → the cockpit fills in → the Agents view → a decision → approve.
    name: 'hero',
    budget: 5 * MB,
    async run(page, base, rec) {
      await openManDeparture(page, base, rec);
      await click(page, page.getByTestId('flight-panel').getByRole('button', { name: 'Report incident' }));
      const dialog = page.getByTestId('report-dialog');
      await dialog.waitFor();
      await pause(page, 900);
      await click(page, dialog.locator('[data-incident-type="pushback_tug_contact"]'), { dx: 0.3 });
      await pause(page, 1500);
      await pointAt(page, dialog.getByLabel('Speed'));
      await dialog.getByLabel('Speed').selectOption('30');
      await pause(page, 500);
      await click(page, dialog.getByRole('button', { name: 'Start' }));
      await page.getByTestId('kpi-value-cost').waitFor({ timeout: 15_000 });
      await glide(page, 760, 470, 900);
      await pause(page, 4200);
      await click(page, page.locator('[data-zone-expand="agents"]'));
      await page.waitForURL(/\/agents$/);
      await glide(page, 720, 520, 800);
      const popup = page.locator('[data-decision-popup] article').first();
      await popup.waitFor({ timeout: 60_000 });
      await pause(page, 900);
      await pointAt(page, popup.getByText('Approving authorises'), { dx: 1.2, ms: 700 });
      await pause(page, 1400);
      await click(page, popup.getByRole('button', { name: /^Approve/ }));
      await page
        .locator('[data-column="passenger"] [data-kind="decision"]')
        .first()
        .waitFor({ timeout: 15_000 });
      await glide(page, 1000, 600, 700);
      await pause(page, 3200);
    },
  },
  {
    // An airborne flight: the options-only note, the airborne incident list, then Start.
    name: 'flight-to-incident',
    budget: 2 * MB,
    async run(page, base, rec) {
      await page.goto(`${base}/?at=12:00`);
      await page.waitForSelector('[data-testid="network-map"] canvas');
      await pause(page, 1000);
      await rec.start();
      await pause(page, 500);
      await click(page, page.getByRole('button', { name: 'Airborne', exact: true }));
      await pause(page, 300);
      await click(page, page.getByRole('listbox', { name: 'Flights' }).getByRole('option').nth(1), {
        dx: 0.3,
      });
      const panel = page.getByTestId('flight-panel');
      await panel.waitFor();
      await pointAt(page, panel.getByTestId('options-only-note'), { dx: 0.3 });
      await pause(page, 1000);
      await click(page, panel.getByRole('button', { name: 'Report incident' }));
      const dialog = page.getByTestId('report-dialog');
      await dialog.waitFor();
      await pause(page, 300);
      await click(page, dialog.locator('label[data-incident-type]').first(), { dx: 0.3 });
      await dialog.getByTestId('preview-trigger').waitFor();
      await pause(page, 1200);
      await click(page, dialog.getByRole('button', { name: 'Start' }));
      await page.getByTestId('arrival-panel').waitFor({ timeout: 15_000 });
      await glide(page, 700, 460, 600);
      await pause(page, 1600);
    },
  },
  {
    // The decision card says what approving authorises and what it does not; the approval becomes a row.
    name: 'human-authority',
    budget: 2 * MB,
    crop: [860, 900, 580, 0],
    async run(page, base, rec) {
      await startTraining(page, base, S01, { speed: '30' });
      await page.locator('[data-zone-expand="agents"]').click();
      await page.waitForURL(/\/agents$/);
      await glide(page, 760, 300, 100);
      const popup = page.locator('[data-decision-popup] article').first();
      await popup.waitFor({ timeout: 60_000 });
      await pause(page, 600);
      await rec.start();
      await pause(page, 900);
      await pointAt(page, popup.getByText('Approving authorises'), { dx: 1.2, ms: 800 });
      await pause(page, 1600);
      await pointAt(page, popup.getByText('It does not authorise'), { dx: 1.2, ms: 500 });
      await pause(page, 1800);
      await click(page, popup.getByRole('button', { name: /^Approve/ }));
      await page
        .locator('[data-column="passenger"] [data-kind="decision"]')
        .first()
        .waitFor({ timeout: 15_000 });
      await glide(page, 900, 820, 600);
      await pause(page, 2800);
    },
  },
  {
    // A presenter pushes a forbidden call through the real tier gate: blocked, counted, nothing changed.
    name: 'blocked-by-design',
    budget: 2 * MB,
    async run(page, base, rec) {
      await startTraining(page, base, S01, { speed: '6' });
      await pause(page, 2500);
      await glide(page, 1250, 40, 100);
      await rec.start();
      await pause(page, 700);
      await command(page, 'Demonstrate blocked action');
      const card = page.locator('[data-blocked-card]').filter({ hasText: 'Presenter-triggered' }).first();
      await card.waitFor({ timeout: 15_000 });
      await pointAt(page, page.getByTestId('kpi-value-safety').or(page.locator('#zone-agents')).first(), {
        ms: 700,
      }).catch(() => undefined);
      await pause(page, 1200);
      await page.locator('#zone-agents').focus();
      await page.keyboard.press('f');
      await pause(page, 600);
      await pointAt(page, page.locator('#zone-agents').getByText('Blocked by autonomy policy').first(), {
        dx: 0.1,
        ms: 700,
      });
      await pause(page, 3200);
    },
  },
  {
    // The engineer's ETA slips: the approval that relied on it is withdrawn and a revised proposal follows.
    name: 'assumption-changed',
    budget: 2 * MB,
    crop: [860, 900, 580, 0],
    async run(page, base, rec) {
      await startTraining(page, base, S04, { speed: '30', query: '?autopilot=1' });
      await page.locator('[data-zone-expand="agents"]').click();
      await page.waitForURL(/\/agents$/);
      await glide(page, 1300, 860, 100);
      await waitForIncidentMinuteOnAgents(page, 22);
      await rec.start();
      const withdrawn = page.locator('[data-column="passenger"] [data-kind="invalidated"]').first();
      await withdrawn.waitFor({ timeout: 60_000 });
      await pause(page, 600);
      await pointAt(page, withdrawn, { dx: 0.35, ms: 700 });
      await page
        .locator('[data-column="passenger"] [data-kind="proposal"]')
        .last()
        .waitFor({ timeout: 30_000 });
      await pause(page, 1500);
      const revised = page.locator('[data-column="passenger"] [data-kind="decision"]').last();
      await revised.waitFor({ timeout: 30_000 });
      await pause(page, 3500);
    },
  },
  {
    // Scrub back in the Agents view: rows, statuses and the dashboard are rebuilt from the event log.
    name: 'time-travel',
    budget: 2 * MB,
    async run(page, base, rec) {
      await page.goto(`${base}/runs/run-demo-s01/agents`);
      await page.locator('[data-column="maintenance"] [data-kind="tool"]').first().waitFor();
      await pause(page, 800);
      const scrubber = page.getByTestId('agents-scrubber');
      const box = await scrubber.boundingBox();
      const y = box.y + box.height / 2;
      await glide(page, box.x + box.width - 2, y, 100);
      await rec.start();
      await pause(page, 1000);
      await page.mouse.down();
      for (let i = 1; i <= 60; i++) {
        await page.mouse.move(box.x + box.width - 2 - (box.width * 0.82 * i) / 60, y);
        await pause(page, 45);
      }
      await page.mouse.up();
      page.__pos = { x: box.x + box.width * 0.18, y };
      await pause(page, 1800);
      await click(page, page.getByRole('link', { name: 'Back to the dashboard' }));
      await page.getByText(/history · m\d+ — go live/).waitFor();
      await glide(page, 720, 140, 700);
      await pause(page, 2200);
      await click(page, page.getByText(/history · m\d+ — go live/));
      await pause(page, 1800);
    },
  },
  {
    // Every model call and tool call, as sent and as returned.
    name: 'audit',
    budget: 2 * MB,
    async run(page, base, rec) {
      await page.goto(`${base}/audit`);
      await page.getByTestId('audit-runs').waitFor();
      await pause(page, 600);
      await rec.start();
      await pause(page, 800);
      const runRow = page
        .getByTestId('audit-runs')
        .locator('tr', { hasText: 'agent' })
        .filter({ hasText: 'Towbar' })
        .first();
      await click(page, runRow.getByRole('link'));
      await page.getByTestId('audit-table').waitFor();
      await pause(page, 900);
      const llmRow = page.locator('[data-kind="llm"]').first();
      await click(page, llmRow.locator('[data-audit-toggle]'));
      await pause(page, 2000);
      const output = llmRow.getByRole('region', { name: 'Model output' });
      await click(page, output.getByRole('tab', { name: 'Raw JSON' }));
      await pause(page, 1800);
      await page.mouse.wheel(0, 420);
      await pause(page, 1800);
    },
  },
];

async function waitForIncidentMinuteOnAgents(page, minute) {
  // The Agents view has no incident clock: read the minute of the newest row.
  for (let i = 0; i < 1200; i++) {
    const minutes = await page
      .locator('[data-minute]')
      .evaluateAll((els) => els.map((e) => Number((e.textContent || '').replace(/[^\d]/g, '')) || 0));
    if (minutes.length && Math.max(...minutes) >= minute) return;
    await pause(page, 100);
  }
  throw new Error(`no row reached m${minute}`);
}

// ------------------------------------------------------------------------------------------ screenshots

const SHOTS = [
  {
    name: 'network',
    async run(page, base) {
      await openManDeparture(page, base);
      await page.mouse.move(-10, -10);
      await pause(page, 600);
    },
  },
  {
    name: 'cockpit-options',
    async run(page, base) {
      await startTraining(page, base, S04, { speed: '30' });
      const first = page.locator('[data-decision-popup] article[data-popup-approval="ap4-msg-1"]');
      await first.waitFor({ timeout: 60_000 });
      await first.getByRole('button', { name: /^Approve/ }).click();
      await page
        .locator('[data-decision-popup] article[data-popup-approval="ap4-decision-1"]')
        .waitFor({ timeout: 60_000 });
      await page.mouse.move(-10, -10);
      await pause(page, 1500);
    },
  },
  {
    name: 'agents',
    async run(page, base) {
      await startTraining(page, base, S04, { speed: '30', query: '?autopilot=1' });
      await page.locator('[data-zone-expand="agents"]').click();
      await page.waitForURL(/\/agents$/);
      await page.locator('[data-column="passenger"] [data-kind="invalidated"]').waitFor({ timeout: 90_000 });
      await page.locator('[data-column="passenger"] [data-kind="report"]').waitFor({ timeout: 60_000 });
      await page
        .getByRole('button', { name: 'Pause' })
        .click()
        .catch(() => undefined);
      await page.mouse.move(-10, -10);
      await pause(page, 800);
    },
  },
  {
    name: 'audit',
    async run(page, base) {
      await page.goto(`${base}/audit`);
      const runRow = page
        .getByTestId('audit-runs')
        .locator('tr', { hasText: 'agent' })
        .filter({ hasText: 'Towbar' })
        .first();
      await runRow.getByRole('link').click();
      const llmRow = page.locator('[data-kind="llm"]').first();
      await llmRow.locator('[data-audit-toggle]').click();
      await page.mouse.move(-10, -10);
      await pause(page, 800);
    },
  },
];

async function quantisePng(src, dest) {
  // 256-colour palette PNG: the UI is flat colour, so this is visually lossless at a fraction of the size.
  ffmpeg([
    '-i',
    src,
    '-vf',
    'split[a][b];[a]palettegen=max_colors=256:reserve_transparent=0[p];[b][p]paletteuse=dither=none',
    '-pix_fmt',
    'pal8',
    dest,
  ]);
}

// ------------------------------------------------------------------------------------------ main

mkdirSync(OUT, { recursive: true });
const server = arg('base') ? { base: arg('base'), stop: () => {} } : await startServer();
const browser = await chromium.launch({ args: ['--hide-scrollbars'] });
const pick = (list) => list.filter((c) => !only.length || only.includes(c.name));
let failed = false;
try {
  if (wantGifs) {
    for (const clip of pick(CLIPS)) {
      const page = await newPage(browser);
      const rec = await recorder(page);
      const dir = mkdtempSync(join(tmpdir(), `ica-media-${clip.name}-`));
      try {
        await clip.run(page, server.base, rec);
        const captured = await rec.stop();
        const seconds = (captured.stoppedAt - captured.startedAt).toFixed(1);
        console.log(`  ${clip.name}: ${captured.frames.length} frames over ${seconds} s`);
        if (!encode(writeFrames(captured, dir), clip, dir)) failed = true;
      } finally {
        await page.context().close();
        if (!keepFrames) rmSync(dir, { recursive: true, force: true });
      }
    }
  }
  if (wantPngs) {
    for (const shot of pick(SHOTS)) {
      const page = await newPage(browser);
      const dir = mkdtempSync(join(tmpdir(), `ica-media-${shot.name}-`));
      try {
        await shot.run(page, server.base);
        await page.evaluate(() => document.getElementById('__media-cursor')?.remove());
        const raw = join(dir, 'raw.png');
        await page.screenshot({ path: raw });
        const file = join(OUT, `${shot.name}.png`);
        await quantisePng(raw, file);
        const ok = size(file) <= 600 * 1024;
        if (!ok) failed = true;
        console.log(`${ok ? '✓' : '✗'} ${shot.name}.png ${fmt(size(file))} (budget 0.59 MB)`);
      } finally {
        await page.context().close();
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }
} finally {
  await browser.close();
  server.stop();
}
process.exit(failed ? 1 : 0);
