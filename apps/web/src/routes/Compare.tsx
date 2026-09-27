/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Side-by-side (FR-08): the agent run and the baseline run in lock-step on one timeline (aligned on sim minute),
 * KPI strips stacked, deltas highlighted — the value story is shown, not claimed.
 */
import type { KpiSnapshot, RunProjection, Scenario } from '@ica/schema/browser';
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AppShell } from '../app/AppShell';
import { useServices } from '../app/services';
import { useRun, useRunConnection, useRunStoreInstance } from '../app/useRunConnection';
import { KpiStrip } from '../components/kpi/KpiStrip';
import { autoDecidedApprovals } from '../components/kpi/kpiModel';
import { RotationGantt } from '../components/network/RotationGantt';
import { MarkerGlyph } from '../components/timeline/EventMarkers';
import { TimeScrubber } from '../components/timeline/TimeScrubber';
import { Badge, cx } from '../components/ui/primitives';
import { eventMarkers, kpiSeries, type Marker } from '../lib/derive';
import { formatEurCompact, signed, simClockAt } from '../lib/format';

function Delta({
  label,
  agent,
  base,
  fmt,
  lowerIsBetter = false,
}: {
  label: string;
  agent: number | null;
  base: number | null;
  fmt: (n: number) => string;
  lowerIsBetter?: boolean;
}) {
  if (agent === null || base === null) return null;
  const d = agent - base;
  const better = lowerIsBetter ? d < 0 : d > 0;
  return (
    <span className="num inline-flex items-center gap-1 text-body">
      <span className="text-fg-muted">{label}</span>
      <span
        className={cx(
          'font-semibold',
          Math.round(d) === 0 ? 'text-fg-muted' : better ? 'text-good' : 'text-critical',
        )}
      >
        {signed(d, fmt)}
      </span>
    </span>
  );
}

function Moments({
  markers,
  clock,
  maxMinute,
}: {
  markers: Marker[];
  clock: (m: number) => string;
  maxMinute: number;
}) {
  const shown = markers.filter((m) => m.kind !== 'proposal' && m.minute <= maxMinute + 0.001);
  return (
    <ol className="flex flex-col gap-1" aria-label="Key moments">
      {shown.length === 0 && <li className="text-caption text-fg-subtle">Nothing yet.</li>}
      {shown.map((m) => (
        <li key={m.seq} className="flex items-center gap-2 text-caption">
          <span className="num w-12 shrink-0 text-fg-subtle">{clock(m.minute)}Z</span>
          <MarkerGlyph kind={m.kind} />
          <span className="truncate text-fg-muted" title={m.label}>
            {m.label}
          </span>
        </li>
      ))}
    </ol>
  );
}

function Column({
  title,
  subtitle,
  view,
  markers,
  clock,
}: {
  title: string;
  subtitle: string;
  view: RunProjection;
  markers: Marker[];
  clock: (m: number) => string;
}) {
  const flights = Object.values(view.systems.occ.flights);
  const msgs = Object.values(view.systems.pss.messages).filter((m) => m.status === 'sent');
  const first = view.kpis?.latency.value.firstPaxMessageMin ?? null;
  return (
    <section
      className="flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-surface p-4 shadow-e1"
      aria-label={title}
    >
      <header>
        <h2 className="text-title text-fg">{title}</h2>
        <p className="text-caption text-fg-muted">{subtitle}</p>
      </header>
      <RotationGantt
        flights={flights}
        aircraft={Object.values(view.systems.mne.aircraft)}
        nowIso={view.simTime}
      />
      <p className="num text-body text-fg-muted">
        Passenger messages sent: <span className="text-fg">{msgs.length}</span> · first at{' '}
        <span className="text-fg">{first === null ? '—' : `minute ${first.toFixed(0)}`}</span>
      </p>
      <div
        tabIndex={0}
        role="region"
        aria-label={`${title}: key moments`}
        className="max-h-64 overflow-y-auto"
      >
        <Moments markers={markers} clock={clock} maxMinute={view.simMinute} />
      </div>
    </section>
  );
}

export default function Compare() {
  const { agentRunId = '', baselineRunId = '' } = useParams();
  const { api } = useServices();
  const a = useRunStoreInstance();
  const b = useRunStoreInstance();
  useRunConnection(a, agentRunId);
  useRunConnection(b, baselineRunId, { toasts: false });
  const aView = useRun(a, (s) => s.view);
  const bView = useRun(b, (s) => s.view);
  const aHead = useRun(a, (s) => s.head);
  const bHead = useRun(b, (s) => s.head);
  const aEvents = useRun(a, (s) => s.events);
  const bEvents = useRun(b, (s) => s.events);
  const aAll = useRun(a, (s) => s.log.events);
  const bAll = useRun(b, (s) => s.log.events);
  const aVersion = useRun(a, (s) => s.version);
  const bVersion = useRun(b, (s) => s.version);
  const [minute, setMinute] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(6);
  const [scenario, setScenario] = useState<Scenario | null>(null);

  useEffect(() => {
    if (aHead.meta.scenarioId)
      api.getScenario(aHead.meta.scenarioId).then(setScenario, () => setScenario(null));
  }, [api, aHead.meta.scenarioId]);

  const maxMinute = Math.max(aHead.simMinute, bHead.simMinute);
  const scrub = (m: number | null) => {
    setMinute(m);
    a.getState().setCursorAtMinute(m === null ? Infinity : m);
    b.getState().setCursorAtMinute(m === null ? Infinity : m);
  };
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    let m = minute ?? 0;
    const tick = (t: number) => {
      m += ((t - last) / 60_000) * rate;
      last = t;
      if (m >= maxMinute) {
        scrub(null);
        setPlaying(false);
        return;
      }
      scrub(m);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, rate, maxMinute]);

  const startIso = scenario?.startSimTime ?? null;
  const clock = (m: number) => simClockAt(startIso, m);
  const aSeries = useMemo(() => kpiSeries(aEvents), [aEvents]);
  const bSeries = useMemo(() => kpiSeries(bEvents), [bEvents]);
  const aMarkers = useMemo(() => eventMarkers(aAll), [aAll, aVersion]);
  const bMarkers = useMemo(() => eventMarkers(bAll), [bAll, bVersion]);
  const k: KpiSnapshot | null = aView.kpis;
  const bk: KpiSnapshot | null = bView.kpis;
  const cursorMinute = minute ?? maxMinute;
  const loading = aHead.lastSeq === 0 ? 'loading' : 'ready';

  return (
    <AppShell
      center={
        <div className="flex min-w-0 items-center gap-3">
          <span className="truncate text-body text-fg">
            Side-by-side · {scenario?.title ?? aHead.meta.scenarioId ?? '…'}
          </span>
          <Link
            to={`/runs/${encodeURIComponent(agentRunId)}`}
            className="text-caption text-fg-muted underline decoration-border-control underline-offset-2 hover:text-fg"
          >
            Open cockpit
          </Link>
        </div>
      }
    >
      <div className="mx-auto flex max-w-[1920px] flex-col gap-3 p-3">
        <section
          className="rounded-lg border border-border bg-surface p-3 shadow-e1"
          aria-label="Shared timeline"
        >
          <TimeScrubber
            maxMinute={maxMinute}
            cursorMinute={cursorMinute}
            live={minute === null}
            markers={aMarkers}
            baselineMarkers={bMarkers.filter((m) => m.kind === 'baseline')}
            onScrub={(m) => {
              setPlaying(false);
              scrub(m);
            }}
            onJump={(m) => {
              setPlaying(false);
              scrub(m.minute);
            }}
            onLive={() => {
              setPlaying(false);
              scrub(null);
            }}
            playing={playing}
            onPlayToggle={() => setPlaying(!playing)}
            speed={rate}
            onSpeed={setRate}
            clock={clock}
          />
        </section>

        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <Badge tone="ai" icon="sparkle">
              With agents
            </Badge>
            <span className="text-caption text-fg-muted">human decisions on agent proposals</span>
          </div>
          <KpiStrip
            kpis={k}
            series={aSeries}
            baseline={bk}
            status={loading}
            label="Agent run indicators"
            safety={{ autoApproved: autoDecidedApprovals(aView) }}
            baselineSafety={{ autoApproved: autoDecidedApprovals(bView) }}
          />
          <div
            className="flex flex-wrap items-center gap-x-6 gap-y-1 rounded-md bg-surface-sunken px-3 py-2"
            aria-label="Deltas versus the baseline"
          >
            <span className="caps text-fg-muted">Δ vs manual workflow at {clock(cursorMinute)}Z</span>
            <Delta
              label="Cost"
              agent={k?.totalCostEur.value ?? null}
              base={bk?.totalCostEur.value ?? null}
              fmt={formatEurCompact}
              lowerIsBetter
            />
            <Delta
              label="Satisfaction"
              agent={k?.satisfaction.value ?? null}
              base={bk?.satisfaction.value ?? null}
              fmt={(n) => `${Math.round(n)}`}
            />
            <Delta
              label="Margin to 3 h (min)"
              agent={k?.minutesTo3h ?? null}
              base={bk?.minutesTo3h ?? null}
              fmt={(n) => `${Math.round(n)}`}
            />
            <Delta
              label="Human decisions"
              agent={k?.safety.value.humanDecisionsBeforeDependentActions ?? null}
              base={bk?.safety.value.humanDecisionsBeforeDependentActions ?? null}
              fmt={(n) => `${Math.round(n)}`}
            />
          </div>
          <div className="mt-1 flex items-center gap-2">
            <Badge>Illustrative manual workflow</Badge>
            <span className="text-caption text-fg-muted">
              a scripted human team working without agents (illustrative, not measured)
            </span>
          </div>
          <KpiStrip
            kpis={bk}
            series={bSeries}
            status={bHead.lastSeq === 0 ? 'loading' : 'ready'}
            dense
            label="Illustrative manual workflow indicators"
          />
        </div>

        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <Column title="With agents" subtitle={agentRunId} view={aView} markers={aMarkers} clock={clock} />
          <Column
            title="Illustrative manual workflow"
            subtitle={baselineRunId}
            view={bView}
            markers={bMarkers}
            clock={clock}
          />
        </div>
      </div>
    </AppShell>
  );
}
