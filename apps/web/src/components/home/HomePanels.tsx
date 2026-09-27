/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** Home-page panels: recent runs and the latest evaluation summary. */
import type { EvalReport, RunMeta } from '@ica/schema/browser';
import { Link } from 'react-router-dom';
import { formatInt } from '../../lib/format';
import { Badge, StateFrame, type LoadStatus } from '../ui/primitives';

export function RecentRuns({
  runs,
  status,
  error,
}: {
  runs: RunMeta[];
  status: LoadStatus;
  error?: string | null;
}) {
  const agentRuns = runs.filter((r) => r.mode === 'agent');
  return (
    <section aria-labelledby="recent-h" className="rounded-lg border border-border bg-surface p-4 shadow-e1">
      <h2 id="recent-h" className="text-title text-fg">
        Recent runs
      </h2>
      <div className="mt-2">
        <StateFrame
          status={status}
          error={error}
          empty={agentRuns.length === 0}
          emptyText="No runs yet — start a scenario."
        >
          <ul className="flex flex-col divide-y divide-border">
            {agentRuns.slice(0, 6).map((r) => (
              <li key={r.runId} className="flex items-center gap-2 py-2">
                <Link
                  to={`/runs/${encodeURIComponent(r.runId)}`}
                  className="min-w-0 flex-1 truncate text-body text-fg hover:underline"
                >
                  {r.scenarioTitle}
                </Link>
                <Badge tone={r.status === 'failed' ? 'critical' : 'neutral'}>{r.status}</Badge>
                <span className="num w-12 text-right text-caption text-fg-subtle">
                  m{Math.round(r.simMinute)}
                </span>
                {r.pairedRunId && (
                  <Link
                    to={`/compare/${encodeURIComponent(r.runId)}/${encodeURIComponent(r.pairedRunId)}`}
                    className="text-caption text-fg-muted underline decoration-border-control underline-offset-2 hover:text-fg"
                  >
                    vs baseline
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </StateFrame>
      </div>
    </section>
  );
}

export function EvalSummary({
  report,
  status,
  error,
}: {
  report: EvalReport | null;
  status: LoadStatus;
  error?: string | null;
}) {
  return (
    <section aria-labelledby="eval-h" className="rounded-lg border border-border bg-surface p-4 shadow-e1">
      <div className="flex items-center">
        <h2 id="eval-h" className="text-title text-fg">
          Latest evaluation
        </h2>
        <Link to="/evals" className="ml-auto text-caption text-fg-muted hover:text-fg">
          Full report →
        </Link>
      </div>
      <div className="mt-2">
        <StateFrame status={status} error={error} empty={!report} emptyText="No evaluation report yet.">
          {report && (
            <dl className="grid grid-cols-3 gap-3">
              <div>
                <dt className="caps text-fg-muted">Hard assertions</dt>
                <dd className="num text-figure text-fg">{Math.round(report.hardAssertionPassRate * 100)}%</dd>
              </div>
              <div>
                <dt className="caps text-fg-muted">Judge mean</dt>
                <dd className="num text-figure text-fg">
                  {report.judgeMean === null ? '—' : report.judgeMean.toFixed(1)}
                </dd>
              </div>
              <div>
                <dt className="caps text-fg-muted">Lifetime spend</dt>
                <dd className="num text-figure text-fg">
                  £{report.ledger.spentGbp.toFixed(2)}
                  <span className="text-caption text-fg-subtle">
                    {' '}
                    / £{formatInt(report.ledger.lifetimeCapGbp)}
                  </span>
                </dd>
              </div>
            </dl>
          )}
        </StateFrame>
      </div>
    </section>
  );
}
