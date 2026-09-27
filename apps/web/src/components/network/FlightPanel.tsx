/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * The selected flight: route and phase timeline, position and ETA, passengers by cohort, the crew's duty margin,
 * the tail's rotation (RotationGantt) and, when airborne, the nearest suitable airports as options only. The
 * primary action is "Report incident". Non-modal: the map stays live and clickable beside it.
 */
import {
  OPTIONS_ONLY_NOTE,
  PHASE_LABEL,
  cohortsFor,
  fdpMarginFor,
  flightStateAt,
  isAirborne,
  rotationOf,
  stationByIata,
  suitableAirports,
  type DaySchedule,
  type FlightPhase,
  type NetworkFlight,
} from '@ica/network';
import type { Flight } from '@ica/schema/browser';
import { useMemo, type ReactNode } from 'react';
import { formatDuration, formatUtc } from '../../lib/format';
import { Term } from '../../glossary/Term';
import { IconButton, Badge, Button, cx } from '../ui/primitives';
import { phaseTone } from './FlightList';
import { RotationGantt } from './RotationGantt';

const COHORT_LABEL: Record<string, string> = {
  general: 'General',
  families: 'Families',
  prm: 'Reduced mobility (PRM)',
  premium: 'Premium',
  connections: 'Connections',
  unaccompanied_minors: 'Unaccompanied minors',
};

export function toGanttFlight(f: NetworkFlight, phase: FlightPhase): Flight {
  const status: Flight['status'] = f.cancelled
    ? 'cancelled'
    : phase === 'boarding'
      ? 'boarding'
      : ['taxi_out', 'airborne', 'approach', 'landed', 'at_gate'].includes(phase)
        ? 'departed'
        : f.delayMin > 0
          ? 'delayed'
          : 'scheduled';
  return {
    flight: f.flight,
    tail: f.tail,
    from: f.from,
    to: f.to,
    std: f.std,
    sta: f.sta,
    status,
    delayMin: f.primaryDelayMin,
    reactionaryDelayMin: f.reactionaryDelayMin,
    pax: f.pax,
  };
}

function Section({ title, children, aside }: { title: ReactNode; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="border-b border-border px-4 py-3">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h3 className="text-caption font-semibold uppercase tracking-wide text-fg-muted">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Fact({ label, value, hint }: { label: ReactNode; value: ReactNode; hint?: string }) {
  return (
    <div className="flex flex-col" title={hint}>
      <span className="text-micro text-fg-subtle">{label}</span>
      <span className="num text-body text-fg">{value}</span>
    </div>
  );
}

export function FlightPanel({
  schedule,
  flight: f,
  t,
  onClose,
  onReport,
}: {
  schedule: DaySchedule;
  flight: NetworkFlight;
  t: number;
  onClose: () => void;
  /** "Report incident" (absent = the action is not offered). */
  onReport?: () => void;
}) {
  const st = flightStateAt(f, t);
  const airborne = isAirborne(st.phase);
  const from = stationByIata(f.from);
  const to = stationByIata(f.to);
  const cohorts = useMemo(() => cohortsFor(f), [f]);
  const fdp = useMemo(() => fdpMarginFor(schedule, f.flight), [schedule, f.flight]);
  const rotation = useMemo(() => rotationOf(schedule, f.tail), [schedule, f.tail]);
  const gantt = rotation.map((x) => toGanttFlight(x, flightStateAt(x, t).phase));
  const options = airborne ? suitableAirports(st.position, f.type, { atMs: t, limit: 4 }) : [];

  const marks: { label: string; ms: number; done: boolean }[] = [
    { label: 'STD', ms: f.stdMs, done: t >= f.stdMs },
    { label: 'Off-blocks', ms: st.times.offBlockMs, done: t >= st.times.offBlockMs },
    { label: 'Airborne', ms: st.times.takeoffMs, done: t >= st.times.takeoffMs },
    { label: f.delayMin ? 'ETA' : 'STA', ms: st.times.inBlockMs, done: t >= st.times.inBlockMs },
  ];
  const span = st.times.inBlockMs - f.stdMs;
  const progress = Math.min(1, Math.max(0, (t - f.stdMs) / span));

  return (
    <aside
      aria-label={`Flight ${f.flight}`}
      data-testid="flight-panel"
      className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-surface-raised/95 shadow-e3 backdrop-blur"
    >
      <header className="flex items-start gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="num text-title text-fg">{f.flight}</h2>
            <Badge tone={phaseTone(st.phase)}>{PHASE_LABEL[st.phase]}</Badge>
            {f.delayMin > 0 && !f.cancelled && (
              <Badge tone={f.delayMin >= 30 ? 'critical' : 'warning'}>+{f.delayMin} min</Badge>
            )}
          </div>
          <p className="mt-0.5 truncate text-caption text-fg-muted">
            {from?.city ?? f.from} ({f.from}) → {to?.city ?? f.to} ({f.to}) ·{' '}
            <span className="num">{f.tail}</span> · {f.type}
          </p>
        </div>
        <IconButton icon="close" label="Close flight panel" onClick={onClose} />
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <Section title="Phase">
          <div className="relative mx-1 mb-1 mt-3 h-1 rounded-full bg-surface-hover">
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-brand-accent"
              style={{ width: `${progress * 100}%` }}
            />
            {marks.map((m) => (
              <span
                key={m.label}
                className={cx(
                  'absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2',
                  m.done ? 'border-brand-accent bg-brand-accent' : 'border-border-control bg-surface',
                )}
                style={{ left: `${Math.min(100, Math.max(0, ((m.ms - f.stdMs) / span) * 100))}%` }}
              />
            ))}
          </div>
          <ol className="mt-2 grid grid-cols-4 gap-1">
            {marks.map((m) => (
              <li key={m.label} className="flex flex-col">
                <span className="text-micro text-fg-subtle">
                  {m.label === 'STD' || m.label === 'STA' || m.label === 'ETA' ? (
                    <Term term={m.label}>{m.label}</Term>
                  ) : (
                    m.label
                  )}
                </span>
                <span className={cx('num text-body', m.done ? 'text-fg' : 'text-fg-muted')}>
                  {formatUtc(new Date(m.ms).toISOString())}Z
                </span>
              </li>
            ))}
          </ol>
        </Section>

        {airborne && (
          <Section title="Position">
            <div className="grid grid-cols-3 gap-2">
              <Fact label="Altitude" value={`FL${Math.round(st.altitudeFt / 100)}`} />
              <Fact label="Heading" value={`${st.headingDeg ?? 0}°`} />
              <Fact label="Landing in" value={formatDuration(st.minutesToLanding ?? 0)} />
              <Fact
                label="Lat / lon"
                value={`${st.position.lat.toFixed(2)}, ${st.position.lon.toFixed(2)}`}
              />
              <Fact label="Progress" value={`${Math.round(st.progress * 100)}%`} />
              <Fact
                label="Endurance (notional)"
                value={formatDuration(st.fuelEnduranceMin ?? 0)}
                hint="Illustrative figure for the simulation, not a flight-planning value"
              />
            </div>
          </Section>
        )}

        <Section
          title="Passengers"
          aside={
            <span className="num text-caption text-fg-muted">
              {f.pax} / {f.seats} seats
            </span>
          }
        >
          <ul className="grid grid-cols-2 gap-x-3 gap-y-1">
            {cohorts.map((c) => (
              <li key={c.kind} className="flex justify-between gap-2 text-caption" title={c.notes}>
                <span className="text-fg-muted">{COHORT_LABEL[c.kind] ?? c.kind}</span>
                <span className="num text-fg">{c.count}</span>
              </li>
            ))}
          </ul>
        </Section>

        {fdp && (
          <Section title={<Term term="FDP / duty margin">Crew duty</Term>}>
            <div className="grid grid-cols-3 gap-2">
              <Fact label="Reported" value={`${formatUtc(fdp.report)}Z`} />
              <Fact label="Planned FDP" value={formatDuration(fdp.plannedFdpMin)} />
              <Fact
                label="Margin"
                value={
                  <span
                    className={fdp.marginMin < 0 ? 'text-critical' : fdp.marginMin < 60 ? 'text-warning' : ''}
                  >
                    {formatDuration(Math.abs(fdp.marginMin))}
                    {fdp.marginMin < 0 ? ' over' : ''}
                  </span>
                }
                hint={`Simplified maximum ${formatDuration(fdp.maxFdpMin)}; the commander decides any extension`}
              />
            </div>
          </Section>
        )}

        <Section title={`Rotation · ${f.tail}`}>
          <RotationGantt flights={gantt} nowIso={new Date(t).toISOString()} tailLabel={() => f.type} />
        </Section>

        {airborne && (
          <Section title="Nearest suitable airports">
            <p className="mb-2 text-caption text-fg-muted" data-testid="options-only-note">
              {OPTIONS_ONLY_NOTE}
            </p>
            <ol className="flex flex-col gap-1">
              {options.map((o) => (
                <li key={o.iata} className="flex items-baseline justify-between gap-2 text-caption">
                  <span className={o.suitable ? 'text-fg' : 'text-fg-subtle line-through'}>
                    <span className="num font-medium">{o.iata}</span> {o.city}
                  </span>
                  <span className="num text-fg-muted">
                    {o.distanceKm} km · ~{o.etaMin} min · <Term term="RFFS category">RFFS</Term>{' '}
                    {o.capability.rffsCat}
                  </span>
                </li>
              ))}
            </ol>
          </Section>
        )}
      </div>

      {onReport && (
        <footer className="border-t border-border p-3">
          <Button variant="primary" icon="alert" className="w-full" onClick={onReport} disabled={f.cancelled}>
            Report incident
          </Button>
        </footer>
      )}
    </aside>
  );
}
