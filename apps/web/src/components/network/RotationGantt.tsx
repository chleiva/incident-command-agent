/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * The tail's rotation as a Gantt: scheduled (outline) vs estimated (filled) bars. Amber and red propagate along
 * the line with delays and recede when a swap is approved; bars re-flow to the new tail with motion.
 * Hover (or focus) a bar for knock-on minutes per sector.
 */
import type { Aircraft, Flight } from '@ica/schema/browser';
import { motion } from 'framer-motion';
import { useMemo, useState } from 'react';
import { formatUtc } from '../../lib/format';
import { useElementSize } from '../../lib/useElementSize';
import { StateFrame, type LoadStatus } from '../ui/primitives';
import { flightTone } from './NetworkMap';

const FILL = {
  neutral: 'rgb(var(--c-fg-subtle) / 0.55)',
  warning: 'rgb(var(--c-warning) / 0.85)',
  critical: 'rgb(var(--c-critical) / 0.85)',
  good: 'rgb(var(--c-good) / 0.85)',
} as const;

const LABEL_W = 88;
const ROW_H = 30;

export function RotationGantt({
  flights,
  aircraft = [],
  nowIso,
  status = 'ready',
  error,
  tailLabel,
}: {
  flights: Flight[];
  /** Sub-label under each tail (default: the aircraft status, or "spare"). */
  tailLabel?: (tail: string) => string;
  aircraft?: Aircraft[];
  /** Current scenario time (ISO) for the "now" line. */
  nowIso?: string | null;
  status?: LoadStatus;
  error?: string | null;
}) {
  const [ref, { width }] = useElementSize<HTMLDivElement>({ width: 600, height: 160 });
  const [hover, setHover] = useState<string | null>(null);

  const model = useMemo(() => {
    const tails = [...new Set(flights.map((f) => f.tail))].sort((a, b) => {
      const pa = aircraft.some((x) => x.tail === a) ? 0 : 1;
      const pb = aircraft.some((x) => x.tail === b) ? 0 : 1;
      return pa - pb || a.localeCompare(b);
    });
    const times = flights.flatMap((f) => [
      Date.parse(f.std),
      Date.parse(f.sta) + (f.delayMin + f.reactionaryDelayMin) * 60_000,
    ]);
    const now = nowIso ? Date.parse(nowIso) : NaN;
    const t0 = Math.min(...times, Number.isNaN(now) ? Infinity : now) - 20 * 60_000;
    const t1 = Math.max(...times) + 20 * 60_000;
    return { tails, t0, t1 };
  }, [flights, aircraft, nowIso]);

  const plotW = Math.max(120, width - LABEL_W - 8);
  const x = (t: number) => LABEL_W + ((t - model.t0) / (model.t1 - model.t0)) * plotW;
  const h = model.tails.length * ROW_H + 22;
  const ticks = useMemo(() => {
    const out: number[] = [];
    // One tick per hour, thinned so labels never overlap (≈ 44 px per label).
    const hours = (model.t1 - model.t0) / 3_600_000;
    const step = Math.max(1, Math.ceil((hours * 44) / plotW)) * 60 * 60_000;
    for (let t = Math.ceil(model.t0 / step) * step; t <= model.t1; t += step) out.push(t);
    return out;
  }, [model.t0, model.t1, plotW]);
  const hovered = flights.find((f) => f.flight === hover);

  return (
    <div ref={ref} className="relative w-full">
      <StateFrame
        status={status}
        error={error}
        empty={flights.length === 0}
        emptyText="No rotation loaded yet."
      >
        <svg
          width={width}
          height={h}
          role="group"
          aria-label="Rotation Gantt"
          className="block overflow-visible"
        >
          {ticks.map((t) => (
            <g key={t}>
              <line x1={x(t)} x2={x(t)} y1={0} y2={h - 18} stroke="rgb(var(--c-border))" />
              <text x={x(t) + 2} y={h - 6} fontSize={10} fill="rgb(var(--c-fg-subtle))" className="num">
                {formatUtc(new Date(t).toISOString())}
              </text>
            </g>
          ))}
          {model.tails.map((tail, i) => {
            const ac = aircraft.find((a) => a.tail === tail);
            return (
              <g key={tail}>
                <text x={0} y={i * ROW_H + 18} fontSize={11} fill="rgb(var(--c-fg))" className="num">
                  {tail}
                </text>
                <text x={0} y={i * ROW_H + 28} fontSize={9} fill="rgb(var(--c-fg-subtle))">
                  {tailLabel ? tailLabel(tail) : ac ? ac.status : 'spare'}
                </text>
              </g>
            );
          })}
          {flights.map((f) => {
            const row = model.tails.indexOf(f.tail);
            const y = row * ROW_H + 6;
            const std = Date.parse(f.std);
            const sta = Date.parse(f.sta);
            const shift = (f.delayMin + f.reactionaryDelayMin) * 60_000;
            const tone = flightTone(f);
            const sx = x(std);
            const sw = Math.max(2, x(sta) - x(std));
            const ex = x(std + shift);
            const label = `${f.flight} ${f.from}→${f.to}${shift ? ` +${f.delayMin + f.reactionaryDelayMin}` : ''}`;
            return (
              <g key={f.flight}>
                <rect
                  x={sx}
                  y={y}
                  width={sw}
                  height={18}
                  rx={3}
                  fill="none"
                  stroke="rgb(var(--c-border-control))"
                  strokeDasharray="3 2"
                />
                <motion.g
                  initial={false}
                  animate={{ x: ex - sx, y: 0 }}
                  transition={{ duration: 0.3, ease: [0.2, 0, 0, 1] }}
                >
                  <motion.rect
                    initial={false}
                    animate={{
                      y,
                      fill: f.status === 'departed' ? 'rgb(var(--c-fg-muted) / 0.5)' : FILL[tone],
                    }}
                    transition={{ duration: 0.3, ease: [0.2, 0, 0, 1] }}
                    x={sx}
                    width={sw}
                    height={18}
                    rx={3}
                    tabIndex={0}
                    role="img"
                    aria-label={`${f.flight} ${f.from} to ${f.to} on ${f.tail}: ${f.delayMin} min primary delay, ${f.reactionaryDelayMin} min knock-on, ${f.status}`}
                    onMouseEnter={() => setHover(f.flight)}
                    onMouseLeave={() => setHover(null)}
                    onFocus={() => setHover(f.flight)}
                    onBlur={() => setHover(null)}
                    style={{ outline: 'none' }}
                  />
                  <motion.text
                    initial={false}
                    animate={{ y: y + 13 }}
                    transition={{ duration: 0.3 }}
                    x={sx + 5}
                    fontSize={10}
                    fill={tone === 'neutral' ? 'rgb(var(--c-fg))' : 'rgb(var(--c-bg))'}
                    pointerEvents="none"
                    className="num"
                  >
                    {sw > 70 ? label : f.flight.slice(3)}
                  </motion.text>
                </motion.g>
              </g>
            );
          })}
          {nowIso && (
            <g>
              <line
                x1={x(Date.parse(nowIso))}
                x2={x(Date.parse(nowIso))}
                y1={0}
                y2={h - 18}
                stroke="rgb(var(--c-fg))"
                strokeWidth={1}
              />
              <text x={x(Date.parse(nowIso)) + 3} y={9} fontSize={9} fill="rgb(var(--c-fg-muted))">
                now
              </text>
            </g>
          )}
        </svg>
        <p className="num mt-1 h-4 truncate text-caption text-fg-muted" aria-live="polite">
          {hovered
            ? `${hovered.flight} ${hovered.from}→${hovered.to} · ${hovered.tail} · primary +${hovered.delayMin} min · knock-on +${hovered.reactionaryDelayMin} min · ${hovered.status}`
            : 'Dashed: schedule · filled: estimate. Hover a sector for knock-on minutes.'}
        </p>
      </StateFrame>
    </div>
  );
}
