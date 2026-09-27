/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * The Agents view (task 08, `/runs/:runId/agents`): a per-agent account of the incident, derived in the browser
 * from the run's event log. It shares the dashboard's run store, so selecting a row puts the dashboard into history
 * mode at that moment, and "Back to live" returns both.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { deriveAgents, columnStatus, turnCount, type AgentRow } from '../agents/rows';
import { useRunActions } from '../app/actions';
import { useServices } from '../app/services';
import { AppShell } from '../app/AppShell';
import { useRun, useRunConnection } from '../app/useRunConnection';
import { AgentsBoard } from '../components/agents-view/AgentsBoard';
import { AgentsTimelineBar } from '../components/agents-view/AgentsTimelineBar';
import { Badge } from '../components/ui/primitives';
import { simClockAt } from '../lib/format';
import { useSharedRunStore } from '../store/sharedRuns';
import { useUi } from '../store/ui';

export default function Agents() {
  const { runId = '' } = useParams();
  const navigate = useNavigate();
  const actions = useRunActions();
  const store = useSharedRunStore(runId);
  useRunConnection(store, runId);

  const allEvents = useRun(store, (s) => s.log.events);
  const version = useRun(store, (s) => s.version);
  const view = useRun(store, (s) => s.view);
  const head = useRun(store, (s) => s.head);
  const cursorSeq = useRun(store, (s) => s.cursorSeq);
  const loadError = useRun(store, (s) => s.loadError);
  const live = cursorSeq === null;
  const { api } = useServices();
  const [title, setTitle] = useState<string | null>(null);
  useEffect(() => {
    if (!head.meta.scenarioId) return;
    api.getScenario(head.meta.scenarioId).then(
      (s) => setTitle(s.title),
      () => setTitle(null),
    );
  }, [api, head.meta.scenarioId]);

  const setOpenRunId = useUi((s) => s.setOpenRunId);
  useEffect(() => setOpenRunId(runId), [runId, setOpenRunId]);
  const hideThoughts = useUi((s) => s.hideThoughts);
  const setHideThoughts = useUi((s) => s.setHideThoughts);

  // Keyed on the append counter too: the log array is mutable and grows in place.
  const model = useMemo(() => deriveAgents(allEvents), [allEvents, version]);
  const statusByRole = useMemo(
    () => Object.fromEntries(model.columns.map((c) => [c.role, columnStatus(view, c.role)])),
    [model, view],
  );
  const turnsByRole = useMemo(
    () =>
      Object.fromEntries(
        model.columns.map((c) => [c.role, turnCount(c.rows, cursorSeq ?? Number.POSITIVE_INFINITY)]),
      ),
    [model, cursorSeq],
  );

  const startIso = view.simTime
    ? new Date(Date.parse(view.simTime) - view.simMinute * 60_000).toISOString()
    : null;
  const clock = (m: number) => simClockAt(startIso, m);

  // History playback (the same behaviour as the dashboard's scrubber).
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    if (live || !playing) return;
    let raf = 0;
    let last = performance.now();
    const tick = (t: number) => {
      const s = store.getState();
      s.setCursorAtMinute(s.view.simMinute + ((t - last) / 60_000) * 6);
      last = t;
      if (store.getState().cursorSeq === null) setPlaying(false);
      else raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [live, playing, store]);

  const worldRunning = head.meta.status === 'running';
  const loading = head.lastSeq === 0 && !loadError;
  const loadStatus = loadError && head.lastSeq === 0 ? 'error' : loading ? 'loading' : 'ready';
  const dashboard = `/runs/${encodeURIComponent(runId)}`;

  const onSelectRow = (row: AgentRow) => {
    setPlaying(false);
    store.getState().setCursor(row.seq);
  };

  return (
    <AppShell
      center={
        <div className="flex min-w-0 items-center gap-3">
          <span className="truncate text-body text-fg">
            {title ?? head.meta.scenarioId ?? 'Loading run…'}
          </span>
          <Badge tone={head.meta.status === 'failed' ? 'critical' : 'neutral'}>{head.meta.status}</Badge>
          <Link
            to={dashboard}
            className="whitespace-nowrap text-caption text-fg-muted underline decoration-border-control underline-offset-2 hover:text-fg"
          >
            Back to the dashboard
          </Link>
        </div>
      }
    >
      <div className="flex h-[calc(100vh-48px)] min-h-0 flex-col gap-2 p-2" data-testid="agents-view">
        <h1 className="sr-only">Agents</h1>
        <AgentsTimelineBar
          maxMinute={head.simMinute}
          cursorMinute={view.simMinute}
          live={live}
          clock={clock}
          playing={live ? worldRunning : playing}
          onPlayToggle={() =>
            live
              ? void actions.control(runId, { action: worldRunning ? 'pause' : 'resume' })
              : setPlaying(!playing)
          }
          onScrub={(m) => {
            setPlaying(false);
            store.getState().setCursorAtMinute(m);
          }}
          onLive={() => {
            setPlaying(false);
            store.getState().setCursor(null);
          }}
          hideThoughts={hideThoughts}
          onHideThoughts={setHideThoughts}
        />
        <AgentsBoard
          model={model}
          statusByRole={statusByRole}
          turnsByRole={turnsByRole}
          cursorSeq={cursorSeq}
          hideThoughts={hideThoughts}
          live={live}
          loadStatus={loadStatus}
          error={loadError}
          onSelectRow={onSelectRow}
          decisionHref={`${dashboard}#zone-decisions`}
          onOpenDecisions={() => navigate(`${dashboard}#zone-decisions`)}
        />
      </div>
    </AppShell>
  );
}
