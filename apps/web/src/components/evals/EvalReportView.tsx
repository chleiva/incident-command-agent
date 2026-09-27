/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** The latest eval report: pass rates per layer, judge scores, deltas and the lifetime £10 budget. */
import type { EvalReport } from '@ica/schema/browser';
import { formatInt } from '../../lib/format';
import { Icon } from '../ui/Icon';
import { Badge, StateFrame, cx, type LoadStatus } from '../ui/primitives';

type Extras = { judgeScores?: Record<string, number>; deltas?: Record<string, number> };

function Meter({
  value,
  max = 1,
  tone = 'neutral',
  label,
}: {
  value: number;
  max?: number;
  tone?: 'neutral' | 'warning' | 'critical';
  label: string;
}) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div
      className="h-2 w-full overflow-hidden rounded-full bg-surface-hover"
      role="meter"
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-label={label}
    >
      <div
        className={cx(
          'h-full rounded-full',
          tone === 'critical' ? 'bg-critical' : tone === 'warning' ? 'bg-warning' : 'bg-fg-muted',
        )}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

const humanKey = (k: string) => k.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());

export function EvalReportView({
  report,
  status = 'ready',
  error,
}: {
  report: (EvalReport & Extras) | null;
  status?: LoadStatus;
  error?: string | null;
}) {
  return (
    <StateFrame
      status={status}
      error={error}
      empty={!report}
      emptyText="No evaluation report yet. Run `npm run eval` (free replay tier)."
    >
      {report && (
        <div className="flex flex-col gap-6">
          <div className="flex flex-wrap items-center gap-2 text-caption text-fg-muted">
            <Badge>{report.tier} tier</Badge>
            <span>{report.caseCount} cases</span>
            <span>· {new Date(report.createdAt).toISOString().slice(0, 16).replace('T', ' ')} UTC</span>
            {report.gitSha && <span className="font-mono">· {report.gitSha}</span>}
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <section
              className="rounded-lg border border-border bg-surface p-4 shadow-e1 lg:col-span-2"
              aria-labelledby="layers-h"
            >
              <h2 id="layers-h" className="text-title text-fg">
                Pass rate by layer
              </h2>
              <ul className="mt-3 flex flex-col gap-3">
                {Object.entries(report.passRateByLayer).map(([layer, rate]) => (
                  <li key={layer} className="grid grid-cols-[120px_minmax(0,1fr)_48px] items-center gap-3">
                    <span className="text-body text-fg-muted">{humanKey(layer)}</span>
                    <Meter
                      value={rate}
                      tone={rate < 0.7 ? 'critical' : rate < 0.85 ? 'warning' : 'neutral'}
                      label={`${layer} pass rate`}
                    />
                    <span className="num text-right text-body text-fg">{Math.round(rate * 100)}%</span>
                  </li>
                ))}
              </ul>
              <p className="num mt-4 text-body text-fg-muted">
                Hard assertions:{' '}
                <span className="text-fg">{Math.round(report.hardAssertionPassRate * 100)}%</span> · Judge
                mean:{' '}
                <span className="text-fg">
                  {report.judgeMean === null ? '—' : `${report.judgeMean.toFixed(2)} / 5`}
                </span>
              </p>
            </section>

            <section
              className="rounded-lg border border-border bg-surface p-4 shadow-e1"
              aria-labelledby="budget-h"
            >
              <h2 id="budget-h" className="text-title text-fg">
                Lifetime eval budget
              </h2>
              <p className="num mt-2 text-display text-fg">
                £{report.ledger.spentGbp.toFixed(2)}
                <span className="text-body text-fg-subtle">
                  {' '}
                  of £{formatInt(report.ledger.lifetimeCapGbp)}
                </span>
              </p>
              <div className="mt-2">
                <Meter
                  value={report.ledger.spentGbp + report.ledger.reservedGbp}
                  max={report.ledger.lifetimeCapGbp}
                  tone={
                    report.ledger.remainingGbp < 1
                      ? 'critical'
                      : report.ledger.remainingGbp < 3
                        ? 'warning'
                        : 'neutral'
                  }
                  label="Lifetime spend against the cap"
                />
              </div>
              <dl className="num mt-3 grid grid-cols-2 gap-y-1 text-body">
                <dt className="text-fg-muted">Remaining</dt>
                <dd className="text-right text-fg">£{report.ledger.remainingGbp.toFixed(2)}</dd>
                <dt className="text-fg-muted">Reserved</dt>
                <dd className="text-right text-fg">£{report.ledger.reservedGbp.toFixed(2)}</dd>
                <dt className="text-fg-muted">This report</dt>
                <dd className="text-right text-fg">
                  £{report.spend.gbp.toFixed(2)} (${report.spend.usd.toFixed(2)})
                </dd>
              </dl>
              <p className="mt-3 text-caption text-fg-subtle">Hard cap enforced in code; replays cost £0.</p>
            </section>
          </div>

          <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-3">
            {report.judgeScores && (
              <section
                className="rounded-lg border border-border bg-surface p-4 shadow-e1"
                aria-labelledby="judge-h"
              >
                <h2 id="judge-h" className="text-title text-fg">
                  Judge scores
                </h2>
                <ul className="mt-3 flex flex-col gap-2">
                  {Object.entries(report.judgeScores).map(([k, v]) => (
                    <li key={k} className="grid grid-cols-[110px_minmax(0,1fr)_36px] items-center gap-3">
                      <span className="text-body text-fg-muted">{humanKey(k)}</span>
                      <Meter value={v} max={5} label={`${k} judge score`} />
                      <span className="num text-right text-body text-fg">{v.toFixed(1)}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {report.deltas && (
              <section
                className="rounded-lg border border-border bg-surface p-4 shadow-e1"
                aria-labelledby="delta-h"
              >
                <h2 id="delta-h" className="text-title text-fg">
                  Agents vs baseline (mean)
                </h2>
                <dl className="num mt-3 flex flex-col gap-2 text-body">
                  {Object.entries(report.deltas).map(([k, v]) => (
                    <div key={k} className="flex justify-between">
                      <dt className="text-fg-muted">{humanKey(k)}</dt>
                      <dd className="text-fg">
                        {v > 0 ? '+' : '−'}
                        {formatInt(Math.abs(v))}
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            )}
            <section
              className={cx(
                'rounded-lg border border-border bg-surface p-4 shadow-e1',
                !report.judgeScores && !report.deltas && 'lg:col-span-3',
              )}
              aria-labelledby="cases-h"
            >
              <h2 id="cases-h" className="text-title text-fg">
                Cases
              </h2>
              <ul tabIndex={0} aria-label="Cases" className="mt-2 flex max-h-72 flex-col overflow-y-auto">
                {report.cases.map((c) => (
                  <li
                    key={c.caseId}
                    className="flex items-center gap-2 border-b border-border py-1 text-body last:border-0"
                  >
                    <Icon
                      name={c.skippedReason ? 'dot' : c.passed ? 'check' : 'x'}
                      size={12}
                      className={
                        c.skippedReason ? 'text-fg-subtle' : c.passed ? 'text-fg-muted' : 'text-critical'
                      }
                      label={c.skippedReason ? 'skipped' : c.passed ? 'passed' : 'failed'}
                    />
                    <span className="font-mono text-caption text-fg">{c.caseId}</span>
                    <span className="truncate text-caption text-fg-subtle">
                      {c.skippedReason ?? c.scenarioId}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          </div>
        </div>
      )}
    </StateFrame>
  );
}
