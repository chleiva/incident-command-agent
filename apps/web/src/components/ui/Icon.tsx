/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** A small inline SVG icon set (1.5 px strokes, 16 px grid). Decorative unless `label` is given. */
import type { SVGProps } from 'react';

const PATHS = {
  play: 'M5 3.5v9l7.5-4.5z',
  pause: 'M5 3.5h2v9H5zM9 3.5h2v9H9z',
  live: 'M8 8m-2.5 0a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0 -5 0',
  expand: 'M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5 9 7M2.5 13.5 7 9',
  collapse: 'M13 3 9.5 6.5M9.5 3v3.5H13M3 13l3.5-3.5M6.5 13V9.5H3',
  close: 'M4 4l8 8M12 4l-8 8',
  check: 'M3.5 8.5 6.5 11.5 12.5 4.5',
  x: 'M4.5 4.5l7 7M11.5 4.5l-7 7',
  alert: 'M8 2.5 14 13H2zM8 6.5v3M8 11.2v.3',
  info: 'M8 8m-5.5 0a5.5 5.5 0 1 0 11 0a5.5 5.5 0 1 0 -11 0M8 7.5v3.5M8 5.2v.3',
  sparkle:
    'M8 2.5l1.3 3.2 3.2 1.3-3.2 1.3L8 11.5 6.7 8.3 3.5 7l3.2-1.3zM12.5 11l.5 1.3 1.3.5-1.3.5-.5 1.3-.5-1.3-1.3-.5 1.3-.5z',
  plane: 'M14 8.2 9 6V3a1 1 0 0 0-2 0v3L2 8.2v1.3l5-1v2.8l-1.5 1.2v1l2.5-.6 2.5.6v-1L9 11.3V8.5l5 1z',
  user: 'M8 7.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM3 13.5c.6-2.5 2.6-4 5-4s4.4 1.5 5 4',
  clock: 'M8 8m-5.5 0a5.5 5.5 0 1 0 11 0a5.5 5.5 0 1 0 -11 0M8 5v3.2l2.2 1.3',
  shield: 'M8 2 13 4v4c0 3-2.2 5.2-5 6-2.8-.8-5-3-5-6V4z',
  search: 'M7 7m-4 0a4 4 0 1 0 8 0a4 4 0 1 0 -8 0M10 10l3.5 3.5',
  chevronDown: 'M4 6l4 4 4-4',
  chevronRight: 'M6 4l4 4-4 4',
  download: 'M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10',
  message: 'M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z',
  command:
    'M5.5 5.5h5v5h-5zM5.5 5.5a2 2 0 1 1 0-0.01M10.5 5.5a2 2 0 1 1 0-.01M5.5 10.5a2 2 0 1 0 0 .01M10.5 10.5a2 2 0 1 0 0 .01',
  sun: 'M8 8m-2.8 0a2.8 2.8 0 1 0 5.6 0a2.8 2.8 0 1 0 -5.6 0M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1',
  moon: 'M13 9.5A5.5 5.5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5z',
  wrench: 'M10.5 2.5a3 3 0 0 0-2.8 4L3 11.2l1.8 1.8 4.7-4.7a3 3 0 0 0 4-2.8l-1.8 1.8-1.8-.4-.4-1.8z',
  users:
    'M6 7a2.2 2.2 0 1 0 0-4.4A2.2 2.2 0 0 0 6 7zM2 13c.4-2.2 2-3.5 4-3.5s3.6 1.3 4 3.5M11 7a2 2 0 1 0 0-4M12 9.6c1.2.4 2 1.6 2.3 3.4',
  captions: 'M2 3.5h12v9H2zM4.5 7.5h3M4.5 10h5M9.5 7.5h2',
  link: 'M6.5 9.5l3-3M5 8 3.5 9.5a2.1 2.1 0 0 0 3 3L8 11M8 5l1.5-1.5a2.1 2.1 0 0 1 3 3L11 8',
  filter: 'M2.5 3.5h11L9 9v4l-2-1V9z',
  stop: 'M4.5 4.5h7v7h-7z',
  edit: 'M10.5 2.5l3 3-7.5 7.5H3v-3z',
  file: 'M4 2h5.5L12 4.5V14H4zM9 2v3h3',
  dot: 'M8 8m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0',
  thought: 'M4.5 10.5a3 3 0 0 1 .4-6 3.5 3.5 0 0 1 6.4.6 2.7 2.7 0 0 1-.3 5.4zM5 12.5h.1M3.5 14h.1',
  hourglass: 'M4.5 2.5h7M4.5 13.5h7M5 2.5c0 3.2 6 3 6 5.5s-6 2.3-6 5.5M11 2.5c0 3.2-6 3-6 5.5s6 2.3 6 5.5',
  decision:
    'M6.5 7a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4zM2.5 13c.4-2.2 2-3.5 4-3.5 1 0 1.9.3 2.6.9M9.5 12l1.5 1.5 3-3.5',
  arrowRight: 'M3 8h10M9 4l4 4-4 4',
  arrowLeft: 'M13 8H3M7 4 3 8l4 4',
  undo: 'M5.5 3.5 2.5 6.5l3 3M2.5 6.5h6.5a3.5 3.5 0 0 1 0 7H7',
} as const;

export type IconName = keyof typeof PATHS;

const FILLED: IconName[] = ['play', 'pause', 'live', 'dot', 'stop'];

export function Icon({
  name,
  size = 16,
  label,
  ...rest
}: { name: IconName; size?: number; label?: string } & Omit<SVGProps<SVGSVGElement>, 'name'>) {
  const filled = FILLED.includes(name);
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill={filled ? 'currentColor' : 'none'}
      stroke={filled ? 'none' : 'currentColor'}
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={label ? undefined : true}
      role={label ? 'img' : undefined}
      aria-label={label}
      focusable="false"
      {...rest}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
