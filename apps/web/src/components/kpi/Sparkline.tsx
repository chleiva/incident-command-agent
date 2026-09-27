/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** visx sparkline over the last 60 sim minutes. Decorative: the number beside it carries the meaning. */
import { scaleLinear } from '@visx/scale';
import { LinePath } from '@visx/shape';

export function Sparkline({
  points,
  width = 72,
  height = 22,
  windowMin = 60,
  className = 'text-fg-subtle',
}: {
  points: { minute: number; value: number }[];
  width?: number;
  height?: number;
  windowMin?: number;
  className?: string;
}) {
  if (points.length < 2) return <svg width={width} height={height} aria-hidden />;
  const end = points[points.length - 1]!.minute;
  const start = end - windowMin;
  const visible = points.filter((p) => p.minute >= start);
  const data = visible.length >= 2 ? visible : points.slice(-2);
  const values = data.map((p) => p.value);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const x = scaleLinear({ domain: [Math.max(start, data[0]!.minute), end], range: [1, width - 3] });
  const y = scaleLinear({ domain: lo === hi ? [lo - 1, hi + 1] : [lo, hi], range: [height - 2, 2] });
  const last = data[data.length - 1]!;
  return (
    <svg width={width} height={height} aria-hidden className={className}>
      <LinePath
        data={data}
        x={(p) => x(p.minute)}
        y={(p) => y(p.value)}
        stroke="currentColor"
        strokeWidth={1.25}
        strokeLinejoin="round"
        strokeLinecap="round"
        fill="none"
      />
      <circle cx={x(last.minute)} cy={y(last.value)} r={2} fill="currentColor" />
    </svg>
  );
}
