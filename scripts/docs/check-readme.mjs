/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * npm run docs:check — checks README.md without the network:
 *   - every relative link and image resolves to a file or directory in the repository;
 *   - every in-page anchor (#…) matches a heading (GitHub slug rules);
 *   - every image under docs/media is within its size budget (hero GIF ≤ 5 MB, other GIFs ≤ 2 MB, PNGs ≤ 600 KB);
 *   - every mermaid block is non-empty and starts with a diagram type;
 *   - the author credit is the README's last line and appears nowhere else in the tracked tree.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const README = join(ROOT, 'README.md');
const MEDIA = join(ROOT, 'docs/media');
const CREDIT = 'Built by [Chris Beltran](https://www.linkedin.com/in/chris-ai/)';
const KB = 1024;
const MB = 1024 * KB;

const text = readFileSync(README, 'utf8');
const errors = [];

// Headings → GitHub anchors (lower-case, punctuation dropped, spaces → hyphens, duplicates numbered).
const prose = text.replace(/```[\s\S]*?```/g, '');
const anchors = new Set();
const seen = new Map();
for (const m of prose.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
  const base = m[1]
    .replace(/<[^>]+>/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s/g, '-');
  const n = seen.get(base) ?? 0;
  seen.set(base, n + 1);
  anchors.add(n ? `${base}-${n}` : base);
}

const targets = [
  ...[...prose.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map((m) => m[1]),
  ...[...prose.matchAll(/<img[^>]+src="([^"]+)"/g)].map((m) => m[1]),
];
let checked = 0;
for (const target of targets) {
  if (/^(https?:|mailto:)/.test(target)) continue;
  checked++;
  if (target.startsWith('#')) {
    if (!anchors.has(target.slice(1))) errors.push(`anchor not found: ${target}`);
    continue;
  }
  const [path, hash] = target.split('#');
  const file = join(ROOT, decodeURIComponent(path));
  if (!existsSync(file)) {
    errors.push(`missing file: ${target}`);
    continue;
  }
  if (hash && file === README && !anchors.has(hash)) errors.push(`anchor not found: ${target}`);
}

// Media budgets (every file in docs/media, referenced or not).
let media = 0;
if (existsSync(MEDIA)) {
  for (const name of readdirSync(MEDIA)) {
    const size = statSync(join(MEDIA, name)).size;
    const budget =
      name === 'hero.gif' ? 5 * MB : name.endsWith('.gif') ? 2 * MB : name.endsWith('.png') ? 600 * KB : null;
    if (budget === null) continue;
    media++;
    if (size > budget) errors.push(`over budget: docs/media/${name} is ${(size / MB).toFixed(2)} MB`);
  }
}

// Mermaid blocks: a diagram type on the first line and a body.
const TYPES =
  /^(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram(-v2)?|erDiagram|gantt|pie|journey|mindmap|timeline)\b/;
const mermaid = [...text.matchAll(/```mermaid\n([\s\S]*?)```/g)].map((m) => m[1].trim());
mermaid.forEach((body, i) => {
  if (!TYPES.test(body) || body.split('\n').length < 2)
    errors.push(`mermaid block ${i + 1} has no diagram type or body`);
});

// The one personal credit: README's last line, nowhere else.
const lines = text.trimEnd().split('\n');
if (lines[lines.length - 1] !== CREDIT) errors.push('the credit line is not the last line of README.md');
if (text.split(CREDIT).length !== 2) errors.push('the credit line must appear exactly once in README.md');
let elsewhere = [];
try {
  elsewhere = execFileSync(
    'git',
    ['grep', '-l', '-i', '-e', 'chris beltran', '-e', 'linkedin.com/in/chris-ai'],
    {
      cwd: ROOT,
      encoding: 'utf8',
    },
  )
    .split('\n')
    .filter((f) => f && f !== 'README.md' && f !== 'scripts/docs/check-readme.mjs'); // the checker holds the expected line
} catch {
  /* git grep exits 1 when nothing matches */
}
for (const f of elsewhere) errors.push(`author credit found outside README.md: ${f}`);

if (errors.length) {
  for (const e of errors) console.error(`✗ ${e}`);
  process.exit(1);
}
console.log(
  `README OK: ${checked} relative links/images, ${anchors.size} headings, ${media} media files within budget, ` +
    `${mermaid.length} mermaid block(s), credit line once`,
);
