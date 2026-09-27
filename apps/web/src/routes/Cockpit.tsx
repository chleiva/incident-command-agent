/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * The run cockpit (spec §4 layout, 12-column grid):
 *   Row 1: KPI strip.
 *   Row 2: Network (5) · Ground (4) · Decision rail + Agent activity (3).
 *   Row 3: Passengers (7) · Timeline + System inspector (5).
 * `F` expands the focused zone, `⌘K` opens the palette, `Space` pauses/resumes the world clock.
 */
import type { Engineer, Scenario, ScenarioSummary } from '@ica/schema/browser';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useRunActions } from '../app/actions';
import { AppShell } from '../app/AppShell';
import { useServices } from '../app/services';
import { useLiveMinute } from '../app/useLiveMinute';
import { useRun, useRunConnection, useRunStoreInstance } from '../app/useRunConnection';
import { AgentStream } from '../components/agents/AgentStream';
import { DecisionQueue } from '../components/decisions/DecisionQueue';
import { AirworthinessPanel } from '../components/ground/AirworthinessPanel';
import { StandView } from '../components/ground/StandView';
import { CommsLog } from '../components/passenger/CommsLog';
import { CohortBoard } from '../components/passenger/CohortBoard';
import { PhoneMock } from '../components/passenger/PhoneMock';
import { KpiStrip } from '../components/kpi/KpiStrip';
import type { KpiTileKey } from '../components/kpi/kpiModel';
import { WhyDrawer } from '../components/kpi/WhyDrawer';
import { Narrator } from '../components/narrator/Narrator';
import { NetworkMap } from '../components/network/NetworkMap';
import { RotationGantt } from '../components/network/RotationGantt';
import { SystemTabs } from '../components/inspector/SystemTabs';
import type { PaletteCommand } from '../components/presenter/CommandPalette';
import { RunEndedCard } from '../components/RunEndedCard';
import { TimeScrubber } from '../components/timeline/TimeScrubber';
import { Badge, Button, cx } from '../components/ui/primitives';
import { Zone } from '../components/ui/Zone';
import {
  activeRoles,
  agentFeed,
  decidedApprovals,
  engineerProgress,
  eventMarkers,
  kpiAtMinute,
  kpiSeries,
  latestEngineeringDecision,
  latestProvisionalReading,
  openInvalidations,
  pendingByUrgency,
  recentMutations,
  travelStarts,
} from '../lib/derive';
import { downloadBlob, renderEvidencePdf } from '../lib/evidencePdf';
import { simClockAt } from '../lib/format';
import { stationsForMap } from '../lib/stations';
import { latestCaption } from '../lib/narrator';
import { usePalette } from '../store/palette';
import { useUi } from '../store/ui';

const INTERACTIVE =
  'button, a, input, textarea, select, [role="slider"], [role="radio"], [role="tab"], [contenteditable="true"]';

export default function Cockpit() {
  const { runId = '' } = useParams();
  const services = useServices();
  const { api, app } = services;
  const actions = useRunActions();
  const navigate = useNavigate();
  const primary = useRunStoreInstance();
  const baseline = useRunStoreInstance();
  useRunConnection(primary, runId);

  const view = useRun(primary, (s) => s.view);
  const head = useRun(primary, (s) => s.head);
  const events = useRun(primary, (s) => s.events);
  const allEvents = useRun(primary, (s) => s.log.events);
  const version = useRun(primary, (s) => s.version);
  const cursorSeq = useRun(primary, (s) => s.cursorSeq);
  const streamStatus = useRun(primary, (s) => s.status);
  const loadError = useRun(primary, (s) => s.loadError);
  const live = cursorSeq === null;

  const pairs = useUi((s) => s.pairs);
  const baselineRunId = head.meta.pairedRunId ?? pairs[runId] ?? null;
  useRunConnection(baseline, baselineRunId, { toasts: false });
  const baselineEvents = useRun(baseline, (s) => s.log.events);
  const baselineVersion = useRun(baseline, (s) => s.version);

  const [scenario, setScenario] = useState<Scenario | null>(null);
  const [library, setLibrary] = useState<ScenarioSummary[]>([]);
  useEffect(() => {
    if (!head.meta.scenarioId) return;
    api.getScenario(head.meta.scenarioId).then(setScenario, () => setScenario(null));
  }, [api, head.meta.scenarioId]);
  useEffect(() => {
    api.listScenarios().then(
      (r) => setLibrary(r.items),
      () => setLibrary([]),
    );
  }, [api]);

  // ------------------------------------------------------------------------------------------ derived
  const loading = view.lastSeq === 0 && !loadError;
  const zoneStatus = loadError && view.lastSeq === 0 ? 'error' : loading ? 'loading' : 'ready';
  const startIso =
    scenario?.startSimTime ??
    (view.simTime ? new Date(Date.parse(view.simTime) - view.simMinute * 60_000).toISOString() : null);
  const clock = (m: number) => simClockAt(startIso, m);
  const nowMinute = useLiveMinute(view, live);

  const series = useMemo(() => kpiSeries(events), [events]);
  const baseSeries = useMemo(() => kpiSeries(baselineEvents), [baselineEvents, baselineVersion]);
  const ghost = baselineRunId ? kpiAtMinute(baseSeries, view.simMinute) : null;
  const markers = useMemo(() => eventMarkers(allEvents), [allEvents, version]);
  const baselineMarkers = useMemo(
    () => eventMarkers(baselineEvents).filter((m) => m.kind === 'baseline'),
    [baselineEvents, baselineVersion],
  );
  const feed = useMemo(() => agentFeed(events), [events]);
  const roleStates = useMemo(() => activeRoles(view), [view]);
  const pending = useMemo(() => pendingByUrgency(view), [view]);
  const decided = useMemo(() => decidedApprovals(view), [view]);
  const invalidated = useMemo(() => openInvalidations(view), [view]);
  const reading = useMemo(() => latestProvisionalReading(view)?.reading ?? null, [view]);
  const recent = useMemo(() => recentMutations(events), [events]);
  const starts = useMemo(() => travelStarts(events), [events]);
  const caption = useMemo(() => latestCaption(events), [events]);

  const flights = Object.values(view.systems.occ.flights);
  const aircraft = Object.values(view.systems.mne.aircraft);
  const spares = Object.values(view.systems.occ.spares);
  const engineers = Object.values(view.systems.engineers.engineers);
  const mapStations = stationsForMap(app.stations, [
    ...flights.flatMap((f) => [f.from, f.to]),
    ...aircraft.map((a) => a.station),
    ...spares.map((x) => x.station),
    ...engineers.flatMap((e) => [e.station, ...(e.destination ? [e.destination] : [])]),
  ]);
  const focus = aircraft[0] ?? null;
  const stand = focus?.stand ? view.systems.airport.stands[focus.stand] : undefined;
  const otherStands = Object.values(view.systems.airport.stands).filter(
    (s) => s.id !== focus?.stand && s.station === focus?.station,
  );
  const adjacentStand =
    otherStands.find((s) => s.occupiedByTail && spares.some((sp) => sp.tail === s.occupiedByTail)) ??
    otherStands.find((s) => s.kind === 'contact') ??
    otherStands[0];
  const adjacentSpare = adjacentStand
    ? spares.find((s) => s.tail === adjacentStand.occupiedByTail)
    : undefined;
  const activeEngineer: Engineer | undefined =
    engineers.find((e) => e.status === 'on_site') ??
    engineers.find((e) => e.status === 'travelling' || e.status === 'paged');
  const cohorts = Object.values(view.systems.pss.cohorts);
  const messages = Object.values(view.systems.pss.messages);
  const [selectedMsg, setSelectedMsg] = useState<string | null>(null);
  const shownMsg =
    messages.find((m) => m.id === selectedMsg) ??
    [...messages]
      .filter((m) => m.status === 'sent')
      .sort((a, b) => (b.sentAtMinute ?? 0) - (a.sentAtMinute ?? 0))[0] ??
    messages[0] ??
    null;

  // ------------------------------------------------------------------------------------------ UI state
  const optimistic = useUi((s) => s.optimistic);
  const setOptimistic = useUi((s) => s.setOptimistic);
  const captions = useUi((s) => s.captions);
  const devOverlay = useUi((s) => s.devOverlay);
  const firstEventMs = useUi((s) => s.firstEventMs);
  const setExpanded = useUi((s) => s.setExpandedZone);
  const [why, setWhy] = useState<KpiTileKey | null>(null);
  const [endedDismissed, setEndedDismissed] = useState(false);
  const [exporting, setExporting] = useState<'pdf' | 'json' | null>(null);
  const [playing, setPlaying] = useState(false);
  const [playRate, setPlayRate] = useState(6);
  const lastZone = useRef<string | null>(null);

  // Deep link `?at=<sim minute>` opens the run at that moment (demos, screenshots).
  const [searchParams] = useSearchParams();
  const at = searchParams.get('at');
  useEffect(() => {
    if (searchParams.get('dev') === '1' && !useUi.getState().devOverlay) useUi.getState().toggleDevOverlay();
  }, [searchParams]);
  const appliedAt = useRef(false);
  useEffect(() => {
    if (appliedAt.current || at === null || head.lastSeq === 0) return;
    if (head.meta.status !== 'completed' && head.simMinute < Number(at)) return;
    appliedAt.current = true;
    primary.getState().setCursorAtMinute(Number(at));
  }, [at, head, primary]);

  // Reconcile optimistic approvals once the decision event arrives.
  useEffect(() => {
    for (const id of Object.keys(optimistic)) if (head.approvals[id]?.decision) setOptimistic(id, null);
  }, [head, optimistic, setOptimistic]);

  const ended = live && (head.meta.status === 'completed' || head.meta.status === 'failed');
  const say = useUi((s) => s.announce);
  useEffect(() => {
    if (ended)
      say(`Run ended: ${head.meta.completedReason ?? head.meta.status}. Summary and exports available.`);
  }, [ended, head.meta.completedReason, head.meta.status, say]);

  // History playback: advance the cursor at the chosen rate.
  useEffect(() => {
    if (live || !playing) return;
    let raf = 0;
    let last = performance.now();
    const tick = (t: number) => {
      const s = primary.getState();
      const minute = s.view.simMinute + ((t - last) / 60_000) * playRate;
      last = t;
      s.setCursorAtMinute(minute);
      if (primary.getState().cursorSeq === null) setPlaying(false);
      else raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [live, playing, playRate, primary]);

  const worldRunning = head.meta.status === 'running';
  const toggleWorld = () => void actions.control(runId, { action: worldRunning ? 'pause' : 'resume' });
  const exportPdf = async () => {
    setExporting('pdf');
    try {
      const pack = Object.values(head.systems.record.evidencePacks).at(-1) ?? null;
      const bytes = await renderEvidencePdf({
        carrierName: app.brand.carrierName,
        disclaimer: app.brand.disclaimer,
        scenarioTitle: scenario?.title ?? head.meta.scenarioId ?? runId,
        runId,
        projection: head,
        events: allEvents,
        baselineKpis: baseSeries.at(-1)?.kpis ?? null,
        evidencePack: pack,
      });
      downloadBlob(bytes as Uint8Array<ArrayBuffer>, `${runId}.evidence-pack.pdf`, 'application/pdf');
    } catch (e) {
      useUi.getState().pushToast({
        tone: 'critical',
        title: 'PDF export failed',
        body: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setExporting(null);
    }
  };
  const exportJson = async () => {
    setExporting('json');
    await actions.exportJson(runId);
    setExporting(null);
  };

  // ------------------------------------------------------------------------------------------ keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement;
      if (target.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (e.key === 'f' || e.key === 'F') {
        const zone =
          (document.activeElement?.closest('[data-zone]') as HTMLElement | null)?.dataset.zone ??
          lastZone.current;
        if (!zone) return;
        e.preventDefault();
        const cur = useUi.getState().expandedZone;
        setExpanded(cur === zone ? null : zone);
      } else if (e.key === ' ' && !target.closest(INTERACTIVE) && !target.closest('[data-approval]')) {
        e.preventDefault();
        toggleWorld();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // ------------------------------------------------------------------------------------------ palette
  const setContext = usePalette((s) => s.setContext);
  const clear = usePalette((s) => s.clear);
  // Commands call through a ref so the list only changes when its content does (cmdk keeps its selection).
  const latest = useRef({ toggleWorld, exportPdf, exportJson });
  latest.current = { toggleWorld, exportPdf, exportJson };
  const markerCount = markers.length;
  useEffect(() => {
    const cmds: PaletteCommand[] = [
      {
        id: 'world',
        group: 'Run',
        label: worldRunning ? 'Pause the world clock' : 'Resume the world clock',
        icon: worldRunning ? 'pause' : 'play',
        shortcut: 'Space',
        run: () => latest.current.toggleWorld(),
      },
      ...[1, 6, 15, 30].map((s) => ({
        id: `speed-${s}`,
        group: 'Run',
        label: `Set speed ${s}×`,
        icon: 'clock' as const,
        keywords: ['speed', 'faster', 'slower'],
        run: () => void actions.control(runId, { action: 'set_speed', speed: s }),
      })),
      // Presenter: push a forbidden call through the REAL tier gate (task 06 §1.3); the refusal appears as a
      // "Blocked by autonomy policy" card in the agent stream.
      ...(
        [
          ['defer_defect', 'Demonstrate blocked action'],
          ['release_aircraft', 'Demonstrate blocked action: release the aircraft'],
          ['extend_crew_fdp', 'Demonstrate blocked action: extend crew FDP'],
        ] as const
      ).map(([tool, label]) => ({
        id: `demo-forbidden-${tool}`,
        group: 'Presenter',
        label,
        icon: 'shield' as const,
        keywords: ['forbidden', 'guardrail', 'autonomy', 'blocked', tool],
        run: () => void actions.control(runId, { action: 'demo_forbidden', tool }),
      })),
      {
        id: 'stop',
        group: 'Run',
        label: 'Stop the run (kill switch)',
        icon: 'stop',
        keywords: ['kill'],
        run: () => void actions.control(runId, { action: 'stop' }),
      },
      {
        id: 'reset',
        group: 'Run',
        label: 'Reset: new run of this scenario',
        icon: 'play',
        disabled: !head.meta.scenarioId,
        run: () =>
          head.meta.scenarioId &&
          void actions.start(head.meta.scenarioId, {
            withBaseline: !!baselineRunId,
            speed: head.meta.speed || 6,
          }),
      },
      {
        id: 'baseline',
        group: 'Run',
        label: baselineRunId ? 'Replay the baseline again' : 'Replay the baseline (paired run)',
        icon: 'users',
        disabled: !head.meta.scenarioId,
        run: () =>
          head.meta.scenarioId &&
          void actions.replayBaseline(runId, head.meta.scenarioId, head.meta.speed || 6),
      },
      {
        id: 'compare',
        group: 'Run',
        label: 'Side-by-side with the baseline',
        icon: 'expand',
        disabled: !baselineRunId,
        run: () =>
          baselineRunId &&
          navigate(`/compare/${encodeURIComponent(runId)}/${encodeURIComponent(baselineRunId)}`),
      },
      {
        id: 'pdf',
        group: 'Run',
        label: 'Export the evidence pack (PDF)',
        icon: 'download',
        run: () => void latest.current.exportPdf(),
      },
      {
        id: 'json',
        group: 'Run',
        label: 'Export the JSON trace',
        icon: 'file',
        run: () => void latest.current.exportJson(),
      },
      ...(scenario?.twists ?? []).map((t) => ({
        id: `twist-${t.id}`,
        group: 'Twists',
        label: `Inject: ${t.title}`,
        icon: 'alert' as const,
        keywords: [t.description],
        run: () => void actions.twist(runId, { twistId: t.id }),
      })),
      {
        id: 'twist-free-text',
        group: 'Twists',
        label: 'Inject a free-text twist…',
        icon: 'edit',
        run: () => {},
      },
      {
        id: 'live',
        group: 'Timeline',
        label: 'Go live (rejoin the head)',
        icon: 'live',
        run: () => primary.getState().setCursor(null),
      },
      ...markers
        .filter((m) => m.kind !== 'proposal')
        .map((m) => ({
          id: `jump-${m.seq}`,
          group: 'Jump to event',
          label: `${clock(m.minute)}Z · ${m.label}`,
          icon: 'chevronRight' as const,
          run: () => primary.getState().setCursor(m.seq),
        })),
      {
        id: 'captions',
        group: 'View',
        label: captions ? 'Hide story captions' : 'Show story captions',
        icon: 'captions',
        run: () => useUi.getState().toggleCaptions(),
      },
      {
        id: 'dev',
        group: 'View',
        label: 'Toggle the dev overlay',
        icon: 'info',
        run: () => useUi.getState().toggleDevOverlay(),
      },
      ...library
        .filter((s) => s.id !== head.meta.scenarioId)
        .map((s) => ({
          id: `switch-${s.id}`,
          group: 'Switch scenario',
          label: `${s.station} · ${s.title}`,
          icon: 'plane' as const,
          run: () => void actions.start(s.id, { withBaseline: true, speed: head.meta.speed || 6 }),
        })),
      ...(services.simulateDrop
        ? [
            {
              id: 'drop',
              group: 'Mock mode',
              label: 'Simulate a connection drop (5 s)',
              icon: 'alert' as const,
              run: services.simulateDrop,
            },
          ]
        : []),
    ];
    setContext(cmds, (text) => void actions.twist(runId, { text }));
  }, [
    worldRunning,
    head.meta.scenarioId,
    head.meta.speed,
    baselineRunId,
    scenario,
    markerCount,
    captions,
    library,
    runId,
    startIso,
  ]);
  useEffect(() => () => clear(), [clear]);

  const showEnded = ended && !endedDismissed;

  return (
    <AppShell
      center={
        <div className="flex min-w-0 items-center gap-3">
          <span className="truncate text-body text-fg" title={scenario?.title}>
            {scenario?.title ?? head.meta.scenarioId ?? 'Loading run…'}
          </span>
          <Badge
            tone={
              head.meta.status === 'failed'
                ? 'critical'
                : head.meta.status === 'paused'
                  ? 'warning'
                  : 'neutral'
            }
          >
            {head.meta.status}
            {head.meta.mode === 'baseline' ? ' · baseline' : ''}
          </Badge>
          <span className="num text-body text-fg-muted" aria-label="Scenario time (UTC)">
            {clock(nowMinute)}Z
          </span>
          <span className="num text-caption text-fg-subtle">{head.meta.speed}×</span>
          {streamStatus === 'reconnecting' && <Badge tone="warning">reconnecting</Badge>}
          {!live && (
            <button
              type="button"
              onClick={() => primary.getState().setCursor(null)}
              className="inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded-sm bg-warning-bg px-2 text-micro font-medium text-warning"
              title="You are viewing the past. Click to go live."
            >
              history · m{view.simMinute.toFixed(0)} — go live
            </button>
          )}
          {baselineRunId && (
            <Link
              className="hidden whitespace-nowrap text-caption text-fg-muted underline decoration-border-control underline-offset-2 hover:text-fg 2xl:inline"
              to={`/compare/${encodeURIComponent(runId)}/${encodeURIComponent(baselineRunId)}`}
            >
              Side-by-side
            </Link>
          )}
          {ended && endedDismissed && (
            <Button size="sm" onClick={() => setEndedDismissed(false)}>
              Summary
            </Button>
          )}
        </div>
      }
    >
      <div
        className={cx(
          'grid grid-cols-1 gap-2 p-2 xl:grid-cols-12 xl:grid-rows-[auto_minmax(0,1.3fr)_minmax(0,1fr)]',
          captions ? 'xl:h-[calc(100vh-88px)]' : 'xl:h-[calc(100vh-48px)]',
        )}
        onPointerDown={(e) => {
          lastZone.current =
            ((e.target as HTMLElement).closest('[data-zone]') as HTMLElement | null)?.dataset.zone ??
            lastZone.current;
        }}
      >
        <div className="xl:col-span-12" data-zone="kpi">
          <KpiStrip
            kpis={view.kpis}
            series={series}
            baseline={ghost}
            status={zoneStatus}
            error={loadError}
            onOpen={setWhy}
          />
        </div>

        <Zone
          id="network"
          title="Network"
          question="Where does the delay spread?"
          className="xl:col-span-5"
          bodyClassName="flex flex-col p-2"
        >
          <div className="min-h-48 flex-1">
            <NetworkMap
              stations={mapStations}
              flights={flights}
              aircraft={aircraft}
              spares={spares}
              engineers={engineers}
              focusTail={focus?.tail}
              status={zoneStatus}
              error={loadError}
            />
          </div>
          <div className="shrink-0 border-t border-border pt-2">
            <RotationGantt
              flights={flights}
              aircraft={aircraft}
              nowIso={view.simTime}
              status={zoneStatus}
              error={loadError}
            />
          </div>
        </Zone>

        <Zone
          id="ground"
          title="Ground"
          question="What is happening at the aircraft?"
          className="xl:col-span-4"
          bodyClassName="zone-scroll flex flex-col gap-2 p-2"
        >
          <StandView
            aircraft={focus}
            stand={stand}
            adjacent={
              adjacentStand
                ? { stand: adjacentStand, tail: adjacentSpare?.tail, assigned: !!adjacentSpare?.assignedTo }
                : null
            }
            engineer={
              activeEngineer
                ? {
                    engineer: activeEngineer,
                    progress: engineerProgress(activeEngineer, starts[activeEngineer.id], nowMinute),
                    etaMin:
                      activeEngineer.etaMinute !== undefined ? activeEngineer.etaMinute - nowMinute : null,
                  }
                : null
            }
            resources={Object.values(view.systems.airport.resourceRequests)}
            weather={focus ? view.systems.airport.weather[focus.station]?.summary : undefined}
            status={zoneStatus}
            error={loadError}
          />
          <AirworthinessPanel
            aircraft={focus}
            reading={reading}
            decision={latestEngineeringDecision(view, focus?.tail)}
            workOrders={Object.values(view.systems.mne.workOrders)}
            status={zoneStatus}
            error={loadError}
            className="shrink-0 border-t border-border pt-2"
          />
        </Zone>

        <div className="flex min-h-0 flex-col gap-2 xl:col-span-3">
          <Zone
            id="decisions"
            title={
              pending.length || invalidated.length
                ? `Decision needed · ${pending.length || invalidated.length}`
                : 'Decision needed'
            }
            question="What needs me?"
            className={cx(
              'shrink-0',
              pending.length + invalidated.length > 0 ? 'max-h-[72%] border-warning/50' : 'max-h-[40%]',
            )}
            bodyClassName="zone-scroll p-2"
          >
            <DecisionQueue
              invalidated={invalidated}
              pending={pending}
              decided={decided}
              nowMinute={nowMinute}
              optimistic={optimistic}
              status={zoneStatus}
              error={loadError}
              announce={live}
              onDecide={(approvalId, req) => {
                if (!live) {
                  useUi
                    .getState()
                    .pushToast({ tone: 'info', title: 'Viewing history', body: 'Go live to decide.' });
                  return;
                }
                void actions.decide(runId, approvalId, req);
              }}
            />
          </Zone>
          <Zone
            id="agents"
            title="Agent activity"
            question="What are the agents doing?"
            className="min-h-64 flex-1 xl:min-h-0"
          >
            <AgentStream items={feed} roleStates={roleStates} status={zoneStatus} error={loadError} />
          </Zone>
        </div>

        <Zone
          id="passengers"
          title="Passengers"
          question="Who is affected, and what have they been told?"
          className="xl:col-span-7"
          bodyClassName="grid min-h-0 grid-cols-1 gap-3 p-3 md:grid-cols-[minmax(0,1.1fr)_auto_minmax(0,0.9fr)]"
        >
          <div tabIndex={0} role="region" aria-label="Passenger cohorts" className="zone-scroll min-h-0">
            <CohortBoard
              cohorts={cohorts}
              nowMinute={nowMinute}
              triggerMinute={scenario?.trigger.atMinute ?? 0}
              status={zoneStatus}
              error={loadError}
            />
          </div>
          <PhoneMock
            message={shownMsg}
            senderId={app.brand.carrierName.toUpperCase()}
            sentAt={shownMsg?.sentAtMinute !== undefined ? `${clock(shownMsg.sentAtMinute)}Z` : undefined}
            status={zoneStatus}
            error={loadError}
          />
          <div tabIndex={0} role="region" aria-label="Communications log" className="zone-scroll min-h-0">
            <h3 className="caps mb-1 text-fg-muted">Communications log</h3>
            <CommsLog
              messages={messages}
              selectedId={shownMsg?.id}
              onSelect={setSelectedMsg}
              clock={(m) => clock(m)}
              cohortSize={(ids) => ids.reduce((n, id) => n + (view.systems.pss.cohorts[id]?.count ?? 0), 0)}
              status={zoneStatus}
              error={loadError}
            />
          </div>
        </Zone>

        <div className="flex min-h-0 flex-col gap-2 xl:col-span-5">
          <Zone
            id="timeline"
            title="Timeline"
            question="What changed, and when?"
            className="shrink-0"
            bodyClassName="p-3"
          >
            <TimeScrubber
              maxMinute={head.simMinute}
              cursorMinute={view.simMinute}
              live={live}
              markers={markers}
              baselineMarkers={baselineMarkers}
              onScrub={(m) => {
                setPlaying(false);
                primary.getState().setCursorAtMinute(m);
              }}
              onJump={(m) => {
                setPlaying(false);
                primary
                  .getState()
                  .setCursor(m.kind === 'baseline' ? primary.getState().log.seqAtMinute(m.minute) : m.seq);
              }}
              onLive={() => {
                setPlaying(false);
                primary.getState().setCursor(null);
              }}
              playing={live ? worldRunning : playing}
              onPlayToggle={() => (live ? toggleWorld() : setPlaying(!playing))}
              speed={live ? head.meta.speed : playRate}
              onSpeed={(s) =>
                live ? void actions.control(runId, { action: 'set_speed', speed: s }) : setPlayRate(s)
              }
              clock={clock}
              status={zoneStatus}
              error={loadError}
            />
          </Zone>
          <Zone
            id="inspector"
            title="System inspector"
            question="What do the airline systems say?"
            className="min-h-48 flex-1 xl:min-h-0"
            bodyClassName="flex flex-col px-3 pb-2"
          >
            <SystemTabs
              systems={view.systems}
              recent={recent}
              lastMutation={view.lastMutation}
              status={zoneStatus}
              error={loadError}
            />
          </Zone>
        </div>
      </div>

      {captions && (
        <div className="flex h-10 items-start justify-center px-2">
          <Narrator caption={view.lastSeq > 0 ? caption : null} />
        </div>
      )}

      {showEnded && (
        <div className="fixed inset-x-0 top-44 z-40 flex justify-center px-4" aria-live="polite">
          <RunEndedCard
            view={head}
            baseline={baseSeries.at(-1)?.kpis ?? null}
            decisions={decidedApprovals(head)}
            onExportPdf={() => void exportPdf()}
            onExportJson={() => void exportJson()}
            onDismiss={() => setEndedDismissed(true)}
            exporting={exporting}
          />
        </div>
      )}

      <WhyDrawer
        tile={why}
        kpis={view.kpis}
        events={allEvents}
        startTime={startIso}
        onClose={() => setWhy(null)}
        onJump={(seq) => {
          setPlaying(false);
          primary.getState().setCursor(seq);
        }}
      />

      {devOverlay && (
        <div className="num fixed bottom-3 left-3 z-50 rounded-md border border-border bg-surface-raised px-3 py-2 text-micro text-fg-muted shadow-e2">
          <div>run {runId}</div>
          <div>
            events {head.lastSeq} · cursor {cursorSeq ?? 'live'} · stream {streamStatus}
          </div>
          <div>
            first event after trigger: {firstEventMs === null ? 'n/a' : `${firstEventMs} ms`} (FR-02 &lt; 2000
            ms)
          </div>
          <div>
            baseline {baselineRunId ?? 'none'} · {baselineEvents.length} events
          </div>
        </div>
      )}
    </AppShell>
  );
}
