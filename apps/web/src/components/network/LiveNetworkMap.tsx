/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * The live network as a full-bleed map on a single canvas (80 moving aircraft at 60 fps): Accent Air's stations
 * (bases emphasised), aircraft glyphs moving along great circles, aircraft on the ground counted at their stations,
 * the selected flight's route. Equal-area projection fitted to the network; no coastlines (no map-data licence
 * needed), a faint graticule gives scale. Motion follows `prefers-reduced-motion` (one redraw per second).
 * The canvas is decorative for assistive tech: the flight list is the accessible way to browse and select.
 */
import {
  NETWORK_STATIONS,
  PHASE_LABEL,
  flightStateAt,
  interpolateGreatCircle,
  isAirborne,
  stationByIata,
  tailStatesAt,
  type DaySchedule,
  type FlightState,
  type NetworkFlight,
} from '@ica/network';
import { geoConicEqualArea, geoGraticule, geoPath, type GeoProjection } from 'd3-geo';
import { useEffect, useMemo, useRef, useState } from 'react';
import { formatUtc } from '../../lib/format';
import { networkNow } from '../../lib/networkClock';
import { useElementSize } from '../../lib/useElementSize';
import { useUi } from '../../store/ui';

interface Glyph {
  flight: NetworkFlight;
  x: number;
  y: number;
  state: FlightState;
}

type Palette = Record<
  'fg' | 'muted' | 'subtle' | 'border' | 'accent' | 'warning' | 'critical' | 'surface',
  string
>;

function readPalette(): Palette {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => {
    const raw = cs.getPropertyValue(name).trim();
    return raw ? `rgb(${raw.split(/\s+/).join(' ')})` : fallback;
  };
  return {
    fg: v('--c-fg', '#e7edf3'),
    muted: v('--c-fg-muted', '#9aa7b4'),
    subtle: v('--c-fg-subtle', '#6b7785'),
    border: v('--c-border', '#2a3440'),
    accent: v('--c-brand-accent', '#4f8fbf'),
    warning: v('--c-warning', '#e0a030'),
    critical: v('--c-critical', '#e05050'),
    surface: v('--c-surface', '#11161c'),
  };
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

const SERVED = NETWORK_STATIONS.filter((s) => s.role !== 'alternate');

export interface LiveNetworkMapProps {
  schedule: DaySchedule;
  selected?: string | null;
  hovered?: string | null;
  onSelect?: (flight: string | null) => void;
  onHover?: (flight: string | null) => void;
  /** Left and right overlay widths (px) to keep the network clear of floating panels. */
  insetLeft?: number;
  insetRight?: number;
  /** Extra stations to label (e.g. diversion options for the selected flight). */
  highlightStations?: string[];
}

export function LiveNetworkMap({
  schedule,
  selected,
  hovered,
  onSelect,
  onHover,
  insetLeft = 0,
  insetRight = 0,
  highlightStations = [],
}: LiveNetworkMapProps) {
  const [ref, { width, height }] = useElementSize<HTMLDivElement>({ width: 1200, height: 700 });
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const glyphs = useRef<Glyph[]>([]);
  const theme = useUi((s) => s.theme);
  const [tip, setTip] = useState<Glyph | null>(null);
  const live = useRef({ selected, hovered, highlightStations });
  live.current = { selected, hovered, highlightStations };

  const projection = useMemo<GeoProjection>(() => {
    const p = geoConicEqualArea().parallels([36, 54]).rotate([2, 0]);
    const left = Math.min(insetLeft, width * 0.4) + 32;
    const right = Math.max(left + 200, width - Math.min(insetRight, width * 0.4) - 32);
    p.fitExtent(
      [
        [left, 104],
        [right, Math.max(120, height - 40)],
      ],
      { type: 'MultiPoint', coordinates: SERVED.map((s) => [s.lon, s.lat]) },
    );
    return p;
  }, [width, height, insetLeft, insetRight]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext?.('2d');
    if (!canvas || !ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const pal = readPalette();
    const path = geoPath(projection, ctx);
    const graticule = geoGraticule().step([5, 5])();
    let groundCounts = new Map<string, number>();
    let groundAt = 0;

    const draw = () => {
      const t = networkNow();
      const { selected: sel, hovered: hov, highlightStations: hi } = live.current;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      ctx.lineWidth = 0.6;
      ctx.strokeStyle = pal.border;
      ctx.beginPath();
      path(graticule);
      ctx.stroke();

      // Aircraft on the ground per station (recomputed once a second).
      if (Math.abs(t - groundAt) > 1000) {
        groundAt = t;
        groundCounts = new Map();
        for (const s of tailStatesAt(schedule, t))
          if (!s.airborne) groundCounts.set(s.station, (groundCounts.get(s.station) ?? 0) + 1);
      }

      const next: Glyph[] = [];
      let selectedGlyph: Glyph | null = null;
      let selectedFlight: NetworkFlight | undefined;
      for (const f of schedule.flights) {
        if (f.flight === sel) selectedFlight = f;
        const st = flightStateAt(f, t);
        if (!isAirborne(st.phase)) continue;
        const xy = projection([st.position.lon, st.position.lat]);
        if (!xy) continue;
        const g: Glyph = { flight: f, x: xy[0], y: xy[1], state: st };
        next.push(g);
        if (f.flight === sel) selectedGlyph = g;
        // Faint route for every airborne flight.
        const a = stationByIata(f.from);
        const b = stationByIata(f.to);
        if (a && b) {
          ctx.beginPath();
          path({
            type: 'LineString',
            coordinates: [
              [st.position.lon, st.position.lat],
              [b.lon, b.lat],
            ],
          });
          ctx.strokeStyle = pal.subtle;
          ctx.globalAlpha = 0.35;
          ctx.setLineDash([2, 4]);
          ctx.lineWidth = 1;
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.globalAlpha = 1;
        }
      }
      glyphs.current = next;

      // The selected flight's full route.
      if (selectedFlight) {
        const a = stationByIata(selectedFlight.from);
        const b = stationByIata(selectedFlight.to);
        if (a && b) {
          ctx.beginPath();
          path({
            type: 'LineString',
            coordinates: [
              [a.lon, a.lat],
              [b.lon, b.lat],
            ],
          });
          ctx.strokeStyle = pal.accent;
          ctx.lineWidth = 2;
          ctx.stroke();
        }
      }

      // Stations.
      const labelled = new Set(hi);
      if (selectedFlight) {
        labelled.add(selectedFlight.from);
        labelled.add(selectedFlight.to);
      }
      for (const s of NETWORK_STATIONS) {
        const isServed = s.role !== 'alternate';
        if (!isServed && !labelled.has(s.iata)) continue;
        const xy = projection([s.lon, s.lat]);
        if (!xy) continue;
        const base = s.role === 'main_base' || s.role === 'base';
        const on = labelled.has(s.iata);
        ctx.beginPath();
        ctx.arc(xy[0], xy[1], base ? 5 : 3, 0, Math.PI * 2);
        ctx.fillStyle = base || on ? pal.fg : pal.subtle;
        ctx.fill();
        if (base) {
          ctx.beginPath();
          ctx.arc(xy[0], xy[1], 9, 0, Math.PI * 2);
          ctx.strokeStyle = pal.accent;
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
        if (!isServed) {
          ctx.beginPath();
          ctx.arc(xy[0], xy[1], 7, 0, Math.PI * 2);
          ctx.strokeStyle = pal.warning;
          ctx.lineWidth = 1.25;
          ctx.stroke();
        }
        ctx.font = `${base ? 600 : 500} ${base ? 12 : 10.5}px ui-monospace, SFMono-Regular, Menlo, monospace`;
        ctx.fillStyle = base || on ? pal.fg : pal.muted;
        ctx.fillText(s.iata, xy[0] + (base ? 12 : 6), xy[1] + 4);
        const n = groundCounts.get(s.iata);
        if (n) {
          ctx.font = '500 10px ui-sans-serif, system-ui, sans-serif';
          ctx.fillStyle = pal.muted;
          ctx.fillText(`${n} on ground`, xy[0] + (base ? 12 : 6), xy[1] + 16);
        }
      }

      // Aircraft glyphs.
      for (const g of next) {
        const st = g.state;
        const a = stationByIata(g.flight.from)!;
        const b = stationByIata(g.flight.to)!;
        const ahead = interpolateGreatCircle(a, b, Math.min(1, st.progress + 0.01));
        const q = projection([ahead.lon, ahead.lat]);
        const ang = q ? Math.atan2(q[1] - g.y, q[0] - g.x) : 0;
        const isSel = g.flight.flight === sel;
        const isHov = g.flight.flight === hov;
        const late = g.flight.delayMin >= 15;
        ctx.save();
        ctx.translate(g.x, g.y);
        ctx.rotate(ang);
        const s = isSel ? 1.5 : isHov ? 1.3 : 1;
        ctx.scale(s, s);
        ctx.beginPath();
        // A simple aircraft silhouette pointing along +x.
        ctx.moveTo(8, 0);
        ctx.lineTo(1, -1.4);
        ctx.lineTo(-1, -7);
        ctx.lineTo(-3, -7);
        ctx.lineTo(-2, -1.4);
        ctx.lineTo(-6, -1.2);
        ctx.lineTo(-8, -3.5);
        ctx.lineTo(-9, -3.5);
        ctx.lineTo(-8, 0);
        ctx.lineTo(-9, 3.5);
        ctx.lineTo(-8, 3.5);
        ctx.lineTo(-6, 1.2);
        ctx.lineTo(-2, 1.4);
        ctx.lineTo(-3, 7);
        ctx.lineTo(-1, 7);
        ctx.lineTo(1, 1.4);
        ctx.closePath();
        ctx.fillStyle = isSel ? pal.accent : late ? pal.warning : pal.fg;
        ctx.fill();
        ctx.restore();
        if (isSel || isHov) {
          ctx.beginPath();
          ctx.arc(g.x, g.y, 15, 0, Math.PI * 2);
          ctx.strokeStyle = pal.accent;
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
      }
      if (selectedFlight && !selectedGlyph) {
        // On the ground: ring its station.
        const st = flightStateAt(selectedFlight, t);
        const iata = st.station ?? selectedFlight.from;
        const s = stationByIata(iata);
        const xy = s ? projection([s.lon, s.lat]) : null;
        if (xy) {
          ctx.beginPath();
          ctx.arc(xy[0], xy[1], 14, 0, Math.PI * 2);
          ctx.strokeStyle = pal.accent;
          ctx.lineWidth = 2;
          ctx.stroke();
        }
      }
    };

    let raf = 0;
    let timer: ReturnType<typeof setInterval> | null = null;
    if (prefersReducedMotion()) {
      draw();
      timer = setInterval(draw, 1000);
    } else {
      const loop = () => {
        draw();
        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);
    }
    return () => {
      cancelAnimationFrame(raf);
      if (timer) clearInterval(timer);
    };
  }, [schedule, projection, width, height, theme]);

  const pick = (clientX: number, clientY: number): Glyph | null => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    let best: Glyph | null = null;
    let bestD = 16;
    for (const g of glyphs.current) {
      const d = Math.hypot(g.x - x, g.y - y);
      if (d < bestD) {
        best = g;
        bestD = d;
      }
    }
    return best;
  };

  const airborne = schedule.flights.filter((f) => isAirborne(flightStateAt(f, networkNow()).phase)).length;

  return (
    <div ref={ref} className="absolute inset-0" data-testid="network-map">
      <canvas
        ref={canvasRef}
        style={{ width, height, cursor: tip ? 'pointer' : 'default' }}
        role="img"
        aria-label={`Live network map: ${schedule.carrier.name}, ${schedule.flights.length} flights today, ${airborne} airborne now. Use the flight list to browse and select flights.`}
        onPointerMove={(e) => {
          const g = pick(e.clientX, e.clientY);
          setTip(g);
          onHover?.(g?.flight.flight ?? null);
        }}
        onPointerLeave={() => {
          setTip(null);
          onHover?.(null);
        }}
        onClick={(e) => {
          const g = pick(e.clientX, e.clientY);
          if (g) onSelect?.(g.flight.flight);
        }}
      />
      {tip && (
        <div
          role="tooltip"
          className="pointer-events-none absolute z-10 rounded-md border border-border bg-surface-raised px-2 py-1 text-caption shadow-e2"
          style={{ left: tip.x + 14, top: tip.y + 10 }}
        >
          <div className="num text-fg">
            {tip.flight.flight} · {tip.flight.from}→{tip.flight.to} · {tip.flight.tail}
          </div>
          <div className="num text-fg-muted">
            {PHASE_LABEL[tip.state.phase]} · FL{Math.round(tip.state.altitudeFt / 100)} · ETA{' '}
            {formatUtc(tip.state.eta)}Z{tip.flight.delayMin ? ` · +${tip.flight.delayMin} min` : ''}
          </div>
        </div>
      )}
    </div>
  );
}
