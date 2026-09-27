/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Audit logs (`/audit`, `/runs/:runId/audit`): every LLM call (the exact context sent and the raw model output) and
 * every tool call (raw input and output) of a run, in order. Deep-linkable per run.
 */
import type { RunMeta } from '@ica/schema/browser';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { exportAuditJsonl, loadAudit, loadLlmTrace, type AuditRun, type LoadedTrace } from '../audit/audit';
import { AppShell } from '../app/AppShell';
import { useServices } from '../app/services';
import { AuditView, AUDIT_NOTE } from '../components/audit/AuditView';
import { RecentRunsTable, RunSelect, type FlightLookup } from '../components/audit/RunPicker';
import type { LoadStatus } from '../components/ui/primitives';
import { downloadBlob } from '../lib/evidencePdf';
import { loadAllEvents, runLevelEvents, type RunLevelEvent } from '../lib/runHealth';
import { useUi } from '../store/ui';

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export default function Audit() {
  const { runId = '' } = useParams();
  const navigate = useNavigate();
  const { api, transport } = useServices();
  const setOpenRunId = useUi((s) => s.setOpenRunId);

  const [runs, setRuns] = useState<{ items: RunMeta[]; status: LoadStatus; error: string | null }>({
    items: [],
    status: 'loading',
    error: null,
  });
  const [runsAttempt, setRunsAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    api.listRuns(50).then(
      (r) => live && setRuns({ items: r.items, status: 'ready', error: null }),
      (e: unknown) => live && setRuns({ items: [], status: 'error', error: message(e) }),
    );
    return () => {
      live = false;
    };
  }, [api, runsAttempt]);

  // The flight of each listed run, from its scenario (one request per distinct scenario).
  const [flights, setFlights] = useState<FlightLookup>({});
  useEffect(() => {
    let live = true;
    const ids = [...new Set(runs.items.map((r) => r.scenarioId))];
    void Promise.all(
      ids.map((id) =>
        api.getScenario(id).then(
          (s) => [id, s.airborne?.flight ?? s.aircraft.nextSectors[0]?.flight] as const,
          () => [id, undefined] as const,
        ),
      ),
    ).then((pairs) => live && setFlights(Object.fromEntries(pairs)));
    return () => {
      live = false;
    };
  }, [api, runs.items]);

  const [audit, setAudit] = useState<{ run: AuditRun | null; status: LoadStatus; error: string | null }>({
    run: null,
    status: 'loading',
    error: null,
  });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!runId) return;
    setOpenRunId(runId);
    let live = true;
    setAudit({ run: null, status: 'loading', error: null });
    loadAudit(api, runId).then(
      (run) => live && setAudit({ run, status: 'ready', error: null }),
      (e: unknown) => live && setAudit({ run: null, status: 'error', error: message(e) }),
    );
    return () => {
      live = false;
    };
  }, [api, runId, attempt, setOpenRunId]);

  // Run health for the header: the error message (RunMeta) and the run-level system events (failure, recovery,
  // stop) from the event log. Best effort: the audit itself never waits for these.
  const [health, setHealth] = useState<{ error: string | null; events: RunLevelEvent[] }>({
    error: null,
    events: [],
  });
  useEffect(() => {
    if (!runId) return;
    let live = true;
    setHealth({ error: null, events: [] });
    api.getRun(runId).then(
      (m) => live && setHealth((h) => ({ ...h, error: m.error ?? null })),
      () => undefined,
    );
    loadAllEvents((id, after) => api.listEvents(id, after), runId).then(
      (events) => live && setHealth((h) => ({ ...h, events: runLevelEvents(events) })),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [api, runId, attempt]);

  // One fetch per trace per page visit (the export reuses what the rows already loaded).
  const cache = useRef(new Map<string, Promise<LoadedTrace>>());
  useEffect(() => {
    cache.current = new Map();
  }, [runId]);
  const loadTrace = useCallback(
    (key: string) => {
      let p = cache.current.get(key);
      if (!p) {
        p = loadLlmTrace(api, runId, key, (url) => transport.fetch(url));
        p.catch(() => cache.current.delete(key));
        cache.current.set(key, p);
      }
      return p;
    },
    [api, runId, transport],
  );

  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const onExport = async () => {
    if (!audit.run) return;
    try {
      const text = await exportAuditJsonl(
        audit.run,
        async (key) => (await loadTrace(key)).trace,
        (done, total) => setProgress({ done, total }),
      );
      downloadBlob(text, `${runId}.audit.jsonl`, 'application/x-ndjson');
    } catch (e) {
      setProgress(null);
      setAudit((a) => ({ ...a, error: message(e) }));
    }
  };

  const picker = (
    <RunSelect
      runs={runs.items}
      value={runId}
      flights={flights}
      onChange={(id) => navigate(`/runs/${encodeURIComponent(id)}/audit`)}
    />
  );

  return (
    <AppShell>
      <div className="mx-auto flex h-[calc(100vh-48px)] max-w-[1920px] flex-col gap-3 px-4 py-3">
        {runId ? (
          <AuditView
            run={audit.run}
            status={audit.status}
            error={audit.error}
            onRetry={() => setAttempt(attempt + 1)}
            loadTrace={loadTrace}
            onExport={() => void onExport()}
            exportProgress={progress}
            picker={picker}
            runError={health.error}
            runEvents={health.events}
          />
        ) : (
          <div className="flex flex-col gap-3" data-testid="audit-view">
            <div className="flex flex-col gap-1">
              <h1 className="text-heading text-fg">Audit</h1>
              <p className="text-caption text-fg-muted" data-testid="audit-note">
                {AUDIT_NOTE}
              </p>
            </div>
            <h2 className="text-body font-semibold text-fg">Pick a run</h2>
            <RecentRunsTable
              runs={runs.items}
              status={runs.status}
              error={runs.error}
              onRetry={() => setRunsAttempt(runsAttempt + 1)}
              flights={flights}
            />
          </div>
        )}
      </div>
    </AppShell>
  );
}
