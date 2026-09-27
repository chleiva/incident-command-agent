/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * The day's flights as a searchable, filterable list (flight, tail, route, phase, delay). Keyboard: `/` focuses the
 * search, ↑/↓ move through the list, Enter selects. It is the accessible way to browse the live map.
 */
import {
  AIRBORNE_PHASES,
  BASES,
  PHASE_LABEL,
  flightStateAt,
  type DaySchedule,
  type FlightPhase,
  type NetworkFlight,
} from '@ica/network';
import { useEffect, useMemo, useRef, useState } from 'react';
import { formatUtc } from '../../lib/format';
import { Icon } from '../ui/Icon';
import { Badge, cx, Kbd, type Tone } from '../ui/primitives';

export type FlightFilter = 'all' | 'airborne' | 'ground' | 'base';

const FILTERS: { id: FlightFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'airborne', label: 'Airborne' },
  { id: 'ground', label: 'On ground' },
  { id: 'base', label: 'At my base' },
];

export function phaseTone(phase: FlightPhase): Tone {
  if (phase === 'cancelled') return 'critical';
  return 'neutral';
}

export interface FlightRow {
  flight: NetworkFlight;
  phase: FlightPhase;
}

export function filterFlights(
  schedule: DaySchedule,
  t: number,
  query: string,
  filter: FlightFilter,
  base: string,
): FlightRow[] {
  const q = query.trim().toUpperCase();
  return schedule.flights
    .map((f) => ({ flight: f, phase: flightStateAt(f, t).phase }))
    .filter(({ flight: f, phase }) => {
      if (q && ![f.flight, f.tail, f.from, f.to, `${f.from}-${f.to}`].some((s) => s.includes(q)))
        return false;
      const airborne = AIRBORNE_PHASES.includes(phase);
      if (filter === 'airborne') return airborne;
      if (filter === 'ground') return !airborne && phase !== 'cancelled';
      if (filter === 'base') {
        if (airborne || phase === 'cancelled') return false;
        const at = phase === 'landed' || phase === 'at_gate' ? f.to : f.from;
        return at === base;
      }
      return true;
    })
    .sort((a, b) => rank(a.phase) - rank(b.phase) || a.flight.stdMs - b.flight.stdMs);
}

/** Active flights first, then upcoming, then completed and cancelled. */
function rank(p: FlightPhase): number {
  return {
    approach: 0,
    airborne: 1,
    taxi_out: 2,
    boarding: 3,
    landed: 4,
    scheduled: 5,
    at_gate: 6,
    cancelled: 7,
  }[p];
}

export function FlightList({
  schedule,
  t,
  selected,
  onSelect,
  onHover,
  homeBase = 'MAN',
}: {
  schedule: DaySchedule;
  t: number;
  selected?: string | null;
  onSelect: (flight: string) => void;
  onHover?: (flight: string | null) => void;
  homeBase?: string;
}) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<FlightFilter>('all');
  const [base, setBase] = useState(homeBase);
  const [active, setActive] = useState(0);
  const search = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const rows = useMemo(
    () => filterFlights(schedule, t, query, filter, base),
    [schedule, t, query, filter, base],
  );

  useEffect(() => {
    if (active >= rows.length) setActive(Math.max(0, rows.length - 1));
  }, [rows.length, active]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      e.preventDefault();
      search.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(rows.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      const r = rows[active];
      if (r) {
        e.preventDefault();
        onSelect(r.flight.flight);
      }
    }
  };
  const activeId = rows[active] ? `flight-opt-${rows[active]!.flight.flight}` : undefined;
  const airborneCount = useMemo(
    () => schedule.flights.filter((f) => AIRBORNE_PHASES.includes(flightStateAt(f, t).phase)).length,
    [schedule, t],
  );

  return (
    <section
      aria-label="Flights"
      className="flex h-full min-h-0 flex-col rounded-lg border border-border bg-surface/95 shadow-e2 backdrop-blur"
    >
      <div className="flex flex-col gap-2 border-b border-border p-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-title text-fg">Flights today</h2>
          <span className="num text-caption text-fg-muted">
            {schedule.flights.length} flights · {airborneCount} airborne
          </span>
        </div>
        <label className="relative block">
          <span className="sr-only">Search flights</span>
          <Icon
            name="search"
            size={14}
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-fg-subtle"
          />
          <input
            ref={search}
            type="search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="Flight, tail or airport"
            aria-controls="flight-listbox"
            aria-activedescendant={activeId}
            className="h-8 w-full rounded-md border border-border-control/70 bg-surface-sunken pl-7 pr-8 text-body text-fg placeholder:text-fg-subtle"
          />
          <Kbd className="absolute right-2 top-1/2 -translate-y-1/2">/</Kbd>
        </label>
        <div role="group" aria-label="Filter flights" className="flex flex-wrap items-center gap-1">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              aria-pressed={filter === f.id}
              onClick={() => {
                setFilter(f.id);
                setActive(0);
              }}
              className={cx(
                'h-6 rounded-full px-2 text-caption',
                filter === f.id
                  ? 'bg-fg text-bg'
                  : 'border border-border-control/60 text-fg-muted hover:text-fg',
              )}
            >
              {f.label}
            </button>
          ))}
          {filter === 'base' && (
            <select
              aria-label="My base"
              value={base}
              onChange={(e) => setBase(e.target.value)}
              className="h-6 rounded-md border border-border-control/60 bg-surface px-1 text-caption text-fg"
            >
              {BASES.map((b) => (
                <option key={b}>{b}</option>
              ))}
            </select>
          )}
        </div>
      </div>
      {rows.length === 0 && <p className="p-4 text-caption text-fg-muted">No flights match.</p>}
      <ul
        hidden={rows.length === 0}
        id="flight-listbox"
        ref={listRef}
        role="listbox"
        aria-label="Flights"
        tabIndex={0}
        onKeyDown={onKeyDown}
        aria-activedescendant={activeId}
        className="min-h-0 flex-1 overflow-y-auto p-1 outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        {rows.map((r, i) => {
          const f = r.flight;
          return (
            <li
              key={f.flight}
              id={`flight-opt-${f.flight}`}
              role="option"
              aria-selected={selected === f.flight}
              data-index={i}
              data-flight={f.flight}
              onClick={() => {
                setActive(i);
                onSelect(f.flight);
              }}
              onMouseEnter={() => onHover?.(f.flight)}
              onMouseLeave={() => onHover?.(null)}
              className={cx(
                'grid cursor-pointer grid-cols-[4.2rem_1fr_auto] items-center gap-x-2 rounded-md px-2 py-1.5 text-body',
                selected === f.flight
                  ? 'bg-surface-hover ring-1 ring-brand-accent'
                  : 'hover:bg-surface-hover',
                i === active && 'outline outline-1 outline-focus',
              )}
            >
              <span className="num font-medium text-fg">{f.flight}</span>
              <span className="min-w-0 truncate text-fg-muted">
                <span className="num text-fg">
                  {f.from}→{f.to}
                </span>{' '}
                <span className="num text-caption">
                  {formatUtc(f.std)} · {f.tail}
                </span>
              </span>
              <span className="flex items-center gap-1">
                {f.delayMin > 0 && r.phase !== 'cancelled' && (
                  <span
                    className={cx('num text-caption', f.delayMin >= 30 ? 'text-critical' : 'text-warning')}
                    title={`${f.delayMin} min late (${f.reactionaryDelayMin} min knock-on)`}
                  >
                    +{f.delayMin}
                  </span>
                )}
                <Badge
                  tone={phaseTone(r.phase)}
                  icon={AIRBORNE_PHASES.includes(r.phase) ? 'plane' : undefined}
                >
                  {PHASE_LABEL[r.phase]}
                </Badge>
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
