/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import type { EvalReport } from '@ica/schema/browser';
import { useEffect, useState } from 'react';
import { AppShell } from '../app/AppShell';
import { useServices } from '../app/services';
import { EvalReportView } from '../components/evals/EvalReportView';
import type { LoadStatus } from '../components/ui/primitives';

export default function Evals() {
  const { api } = useServices();
  const [state, setState] = useState<{ report: EvalReport | null; status: LoadStatus; error: string | null }>(
    {
      report: null,
      status: 'loading',
      error: null,
    },
  );
  useEffect(() => {
    api.getLatestEval().then(
      (report) => setState({ report, status: 'ready', error: null }),
      (e: unknown) =>
        setState({ report: null, status: 'error', error: e instanceof Error ? e.message : String(e) }),
    );
  }, [api]);
  return (
    <AppShell>
      <div className="mx-auto flex max-w-[1440px] flex-col gap-4 px-6 py-6">
        <h1 className="text-display text-fg">Evaluation report</h1>
        <EvalReportView report={state.report} status={state.status} error={state.error} />
      </div>
    </AppShell>
  );
}
