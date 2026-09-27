/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Training scenarios: the scenario library (picker), the AuthorBox and recent runs. The live network is the home
 * page; this is the secondary "Training scenarios" route. The evaluation report is not fetched here: it is an
 * offline QA artefact, loaded only on the /evals page (owner decision: keep evals out of the operational flow).
 */
import type { RunMeta, ScenarioSummary } from '@ica/schema/browser';
import { useEffect, useState } from 'react';
import { useRunActions } from '../app/actions';
import { AppShell } from '../app/AppShell';
import { useServices } from '../app/services';
import { authorAndWait } from '../lib/api';
import { brandCredit } from '../lib/brand';
import { AuthorBox } from '../components/presenter/AuthorBox';
import { ScenarioPicker } from '../components/presenter/ScenarioPicker';
import { RecentRuns } from '../components/home/HomePanels';
import { Skeleton, type LoadStatus } from '../components/ui/primitives';

function useLoad<T>(
  load: () => Promise<T>,
  deps: unknown[] = [],
): { data: T | null; status: LoadStatus; error: string | null } {
  const [state, setState] = useState<{ data: T | null; status: LoadStatus; error: string | null }>({
    data: null,
    status: 'loading',
    error: null,
  });
  useEffect(() => {
    let alive = true;
    load().then(
      (data) => alive && setState({ data, status: 'ready', error: null }),
      (e: unknown) =>
        alive && setState({ data: null, status: 'error', error: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      alive = false;
    };
  }, deps);
  return state;
}

export default function Training() {
  const { api, app, canRun } = useServices();
  const credit = brandCredit(app.brand);
  const actions = useRunActions();
  const scenarios = useLoad<ScenarioSummary[]>(() => api.listScenarios().then((r) => r.items));
  const runs = useLoad<RunMeta[]>(() => api.listRuns(12).then((r) => r.items));
  const [starting, setStarting] = useState<string | null>(null);

  return (
    <AppShell>
      <div className="mx-auto flex max-w-[1440px] flex-col gap-6 px-6 py-6">
        <div>
          <h1 className="text-display text-fg">Training scenarios</h1>
          <p className="mt-1 max-w-[70ch] text-body-lg text-fg-muted">
            Rehearse a shipped incident. Specialist agents coordinate the response on simulated airline
            systems; anything that affects people or airworthiness waits for a human decision.
          </p>
        </div>
        <ScenarioPicker
          scenarios={scenarios.data ?? []}
          status={scenarios.status}
          error={scenarios.error}
          starting={starting}
          unavailableReason={(id) => (canRun && !canRun(id) ? 'Mock mode: needs the local dev server' : null)}
          onStart={async (id, opts) => {
            setStarting(id);
            await actions.start(id, opts);
            setStarting(null);
          }}
        />
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <AuthorBox
            onAuthor={(text, onProgress) => authorAndWait(api, text, { onProgress })}
            onStart={(id) => void actions.start(id, { withBaseline: false, speed: 6 })}
          />
          <div className="flex flex-col gap-4">
            {runs.status === 'loading' ? (
              <Skeleton className="h-40" />
            ) : (
              <RecentRuns runs={runs.data ?? []} status={runs.status} error={runs.error} />
            )}
          </div>
        </div>
        {/* The credit only when the active brand pack provides one (none in the public defaults). */}
        {credit && (
          <p className="pb-2 text-center text-micro text-fg-subtle" data-credit>
            Designed and developed by {credit.author}
          </p>
        )}
      </div>
    </AppShell>
  );
}
