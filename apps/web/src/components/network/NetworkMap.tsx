/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Equal-area map (d3-geo conic equal-area, fitted to the stations): the affected tail's sectors, spare candidates
 * and engineers in the air. No coastlines are drawn (no map data licence needed); a faint graticule gives scale.
 */
import type { Aircraft, Engineer, Flight, Spare, Station } from '@ica/schema/browser';
import { geoConicEqualArea, geoGraticule, geoPath } from 'd3-geo';
import { useMemo, useState } from 'react';
import { useElementSize } from '../../lib/useElementSize';
import type { AirborneView } from '../../lib/airborne';
import { StateFrame, type LoadStatus } from '../ui/primitives';

type Tone = 'neutral' | 'warning' | 'critical' | 'good';

export function flightTone(f: Flight): Tone {
  if (f.status === 'cancelled') return 'critical';
  const knock = f.delayMin + f.reactionaryDelayMin;
  if (knock >= 60) return 'critical';
  if (knock > 0 || f.status === 'delayed') return 'warning';
  return 'neutral';
}

const STROKE: Record<Tone, string> = {
  neutral: 'rgb(var(--c-fg-subtle))',
  warning: 'rgb(var(--c-warning))',
  critical: 'rgb(var(--c-critical))',
  good: 'rgb(var(--c-good))',
};

export function NetworkMap({
  stations,
  flights,
  aircraft,
  spares,
  engineers,
  focusTail,
  status = 'ready',
  error,
  airborne = [],
}: {
  stations: Station[];
  flights: Flight[];
  aircraft: Aircraft[];
  spares: Spare[];
  engineers: Engineer[];
  focusTail?: string;
  status?: LoadStatus;
  error?: string | null;
  /** Task 07: aircraft in the air (airborne incidents), drawn moving towards their destination. */
  airborne?: AirborneView[];
}) {
  const [ref, { width, height }] = useElementSize<HTMLDivElement>();
  const [hover, setHover] = useState<string | null>(null);
  const byIata = useMemo(() => new Map(stations.map((s) => [s.iata, s])), [stations]);

  const model = useMemo(() => {
    const used = new Set<string>();
    flights.forEach((f) => (used.add(f.from), used.add(f.to)));
    spares.forEach((s) => used.add(s.station));
    aircraft.forEach((a) => used.add(a.station));
    airborne.forEach((a) => (used.add(a.destination), used.add(a.plannedDestination)));
    // Fit to the stations in play (rotation, spares, incident); fall back to the whole network.
    const inPlay = stations.filter((s) => used.has(s.iata));
    const pts = (inPlay.length >= 2 ? inPlay : stations).map((s) => [s.lon, s.lat] as [number, number]);
    const projection = geoConicEqualArea().parallels([36, 54]).rotate([2, 0]);
    projection.fitExtent(
      [
        [48, 40],
        [Math.max(90, width - 80), Math.max(90, height - 36)],
      ],
      { type: 'MultiPoint', coordinates: pts },
    );
    const path = geoPath(projection);
    const graticule = path(geoGraticule().step([5, 5])()) ?? '';
    return { projection, path, graticule, used };
  }, [stations, flights, spares, aircraft, width, height, airborne]);

  const p = (iata: string) => {
    const s = byIata.get(iata);
    return s ? (model.projection([s.lon, s.lat]) ?? null) : null;
  };
  const focusFlights = flights;
  const spareSlot = new Map<string, number>();
  const affected = aircraft.find((a) => a.tail === focusTail) ?? aircraft[0];
  const hovered = flights.find((f) => f.flight === hover);
  const flying = engineers.filter(
    (e) => e.travelMode === 'fly' && e.destination && e.status === 'travelling',
  );

  return (
    <div ref={ref} className="relative h-full min-h-40 w-full">
      <StateFrame
        status={status}
        error={error}
        empty={stations.length === 0}
        emptyText="No stations configured."
      >
        <svg
          width={width}
          height={height}
          role="img"
          aria-labelledby="netmap-title netmap-desc"
          className="block"
        >
          <title id="netmap-title">Network map</title>
          <desc id="netmap-desc">
            {affected ? `${affected.tail} at ${affected.station} (${affected.status}). ` : ''}
            {flights
              .map((f) => `${f.flight} ${f.from}–${f.to} ${f.delayMin + f.reactionaryDelayMin} min knock-on`)
              .join('; ')}
            {spares.length ? `. Spares: ${spares.map((s) => `${s.tail} at ${s.station}`).join(', ')}` : ''}
          </desc>
          <path d={model.graticule} fill="none" stroke="rgb(var(--c-border))" strokeWidth={0.6} />
          {focusFlights.map((f) => {
            const d = model.path({
              type: 'LineString',
              coordinates: [
                [byIata.get(f.from)?.lon ?? 0, byIata.get(f.from)?.lat ?? 0],
                [byIata.get(f.to)?.lon ?? 0, byIata.get(f.to)?.lat ?? 0],
              ],
            });
            if (!d || !byIata.has(f.from) || !byIata.has(f.to)) return null;
            const tone = flightTone(f);
            return (
              <g key={f.flight}>
                <path
                  d={d}
                  fill="none"
                  stroke={STROKE[tone]}
                  strokeWidth={hover === f.flight ? 3 : 1.75}
                  strokeDasharray={f.tail !== focusTail ? '4 3' : undefined}
                  style={{ transition: 'stroke 300ms, stroke-width 150ms' }}
                />
                <path
                  d={d}
                  fill="none"
                  stroke="transparent"
                  strokeWidth={12}
                  onMouseEnter={() => setHover(f.flight)}
                  onMouseLeave={() => setHover(null)}
                >
                  <title>{`${f.flight} ${f.from}→${f.to}: ${f.delayMin} min primary, ${f.reactionaryDelayMin} min knock-on`}</title>
                </path>
              </g>
            );
          })}
          {flying.map((e) => {
            const a = p(e.station);
            const b = p(e.destination!);
            if (!a || !b) return null;
            return (
              <line
                key={e.id}
                x1={a[0]}
                y1={a[1]}
                x2={b[0]}
                y2={b[1]}
                stroke="rgb(var(--c-fg-muted))"
                strokeDasharray="2 4"
              />
            );
          })}
          {airborne.map((a) => {
            const xy = model.projection([a.lon, a.lat]);
            const to = p(a.destination);
            if (!xy) return null;
            const ang =
              to && a.phase !== 'landed' ? (Math.atan2(to[1] - xy[1], to[0] - xy[0]) * 180) / Math.PI : 0;
            const tone: Tone =
              a.squawk === 'mayday' ? 'critical' : a.squawk === 'pan' ? 'warning' : 'neutral';
            return (
              <g key={a.flight} data-airborne={a.flight}>
                {to && a.phase !== 'landed' && (
                  <line
                    x1={xy[0]}
                    y1={xy[1]}
                    x2={to[0]}
                    y2={to[1]}
                    stroke={STROKE[tone]}
                    strokeDasharray="5 4"
                    strokeWidth={1.5}
                  />
                )}
                <g transform={`translate(${xy[0]},${xy[1]}) rotate(${ang})`}>
                  <path
                    d="M9 0 L1 -1.5 L-1 -8 L-3.5 -8 L-2 -1.5 L-6.5 -1.3 L-8.5 -4 L-10 -4 L-8.5 0 L-10 4 L-8.5 4 L-6.5 1.3 L-2 1.5 L-3.5 8 L-1 8 L1 1.5 Z"
                    fill={tone === 'neutral' ? 'rgb(var(--c-fg))' : STROKE[tone]}
                  />
                </g>
                <text x={xy[0] + 12} y={xy[1] - 10} fontSize={11} className="num" fill="rgb(var(--c-fg))">
                  {a.flight} → {a.destination}
                  {a.phase === 'landed' ? ' · landed' : ` · ${a.minutesToLanding} min`}
                </text>
              </g>
            );
          })}
          {stations.map((s) => {
            const xy = p(s.iata);
            if (!xy) return null;
            // Put the label on the left when another station sits just to the right.
            const near = (side: 1 | -1) =>
              stations.some((o) => {
                if (o.iata === s.iata) return false;
                const q = p(o.iata);
                const dx = q ? (q[0] - xy[0]) * side : -1;
                return !!q && dx > 0 && dx < 64 && Math.abs(q[1] - xy[1]) < 16;
              });
            const isIncident = affected?.station === s.iata;
            const crowded = !isIncident && near(1) && !near(-1);
            const used = model.used.has(s.iata);
            const tone: Tone = isIncident
              ? affected?.status === 'aog'
                ? 'critical'
                : affected?.status === 'unserviceable'
                  ? 'warning'
                  : 'neutral'
              : 'neutral';
            return (
              <g key={s.iata} transform={`translate(${xy[0]},${xy[1]})`}>
                {isIncident && tone !== 'neutral' && (
                  <circle r={10} fill="none" stroke={STROKE[tone]} strokeWidth={1.5} opacity={0.8} />
                )}
                <circle r={used ? 3.5 : 2} fill={used ? 'rgb(var(--c-fg))' : 'rgb(var(--c-fg-subtle))'} />
                <text
                  x={crowded ? -7 : isIncident ? 13 : 7}
                  y={4}
                  textAnchor={crowded ? 'end' : 'start'}
                  className="num"
                  fontSize={used ? 11 : 10}
                  fill={used ? 'rgb(var(--c-fg))' : 'rgb(var(--c-fg-subtle))'}
                >
                  {s.iata}
                </text>
              </g>
            );
          })}
          {spares.map((s) => {
            const xy = p(s.station);
            if (!xy) return null;
            const slot = spareSlot.get(s.station) ?? 0;
            spareSlot.set(s.station, slot + 1);
            return (
              <g key={s.tail} transform={`translate(${xy[0] + 7},${xy[1] + 16 + slot * 16})`}>
                <rect
                  x={-2}
                  y={-9}
                  width={62}
                  height={14}
                  rx={3}
                  fill="rgb(var(--c-surface-raised))"
                  stroke={s.assignedTo ? STROKE.good : 'rgb(var(--c-border-control))'}
                />
                <text x={3} y={1} fontSize={10} fill={s.assignedTo ? STROKE.good : 'rgb(var(--c-fg-muted))'}>
                  {s.assignedTo ? `✓ ${s.tail}` : `spare ${s.tail.slice(3)}`}
                </text>
              </g>
            );
          })}
        </svg>
        <div className="pointer-events-none absolute left-2 top-2 flex flex-col gap-0.5 rounded-md bg-surface/80 px-2 py-1 text-caption">
          {hovered ? (
            <>
              <span className="text-fg">
                {hovered.flight} {hovered.from}→{hovered.to} · {hovered.tail}
              </span>
              <span className="num text-fg-muted">
                +{hovered.delayMin} min primary · +{hovered.reactionaryDelayMin} min knock-on
              </span>
            </>
          ) : affected ? (
            <span className="text-fg-muted">
              <span className="text-fg">{affected.tail}</span> at {affected.station} · {affected.status}
            </span>
          ) : null}
        </div>
      </StateFrame>
    </div>
  );
}
