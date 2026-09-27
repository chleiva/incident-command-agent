/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** The "Run ended" summary: headline KPIs vs the baseline, the decisions taken, and the exports. */
import type { KpiSnapshot, ProjectedApproval, RunProjection } from '@ica/schema/browser';
import { motion } from 'framer-motion';
import { actorLabel, formatDuration, formatEur, humaniseTool, signed } from '../lib/format';
import { runFailure, runOutcome } from '../lib/runHealth';
import { Icon } from './ui/Icon';
import { Button, IconButton, cx } from './ui/primitives';

function Row({
  label,
  value,
  base,
  better,
}: {
  label: string;
  value: string;
  base?: string;
  better?: boolean | null;
}) {
  return (
    <tr className="border-b border-border last:border-0">
      <th scope="row" className="py-1 pr-3 text-left font-normal text-fg-muted">
        {label}
      </th>
      <td className="num py-1 pr-3 text-right text-fg">{value}</td>
      <td className={cx('num py-1 text-right', better === true ? 'text-good' : 'text-fg-subtle')}>
        {base ?? '—'}
      </td>
    </tr>
  );
}

export function RunEndedCard({
  view,
  baseline,
  decisions,
  onExportPdf,
  onExportJson,
  onDismiss,
  exporting,
}: {
  view: RunProjection;
  baseline: KpiSnapshot | null;
  decisions: ProjectedApproval[];
  onExportPdf: () => void;
  onExportJson: () => void;
  onDismiss: () => void;
  exporting?: 'pdf' | 'json' | null;
}) {
  const k = view.kpis;
  const outcome = runOutcome(view.meta);
  const failed = outcome.kind === 'failed';
  const failure = failed ? runFailure(view) : null;
  const title =
    outcome.kind === 'failed'
      ? 'Run stopped by a system error'
      : outcome.kind === 'stopped'
        ? 'Run stopped'
        : outcome.kind === 'aborted'
          ? 'Run aborted'
          : 'Run complete';
  return (
    <motion.section
      role="region"
      aria-labelledby="run-ended-title"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: [0.2, 0, 0, 1] }}
      className="w-[520px] max-w-[calc(100vw-32px)] rounded-xl border border-border bg-surface-raised p-5 shadow-e3"
    >
      <div className="flex items-start gap-3">
        <span
          className={cx(
            'mt-1',
            failed ? 'text-critical' : outcome.kind === 'completed' ? 'text-good' : 'text-warning',
          )}
        >
          <Icon name={outcome.kind === 'completed' ? 'check' : 'alert'} size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id="run-ended-title" className="text-heading text-fg">
            {title}
          </h2>
          <p className="text-caption text-fg-muted">
            {failure
              ? `Cause: ${failure.plain} · sim minute ${view.simMinute.toFixed(0)}`
              : outcome.kind === 'stopped'
                ? `Stopped by the presenter (kill switch) · sim minute ${view.simMinute.toFixed(0)}`
                : `${view.meta.completedReason ?? outcome.label} · sim minute ${view.simMinute.toFixed(0)}`}
          </p>
        </div>
        <IconButton icon="close" label="Dismiss summary" onClick={onDismiss} />
      </div>
      {k && (
        <table className="mt-4 w-full text-body">
          <thead>
            <tr className="text-micro text-fg-subtle">
              <th />
              <th className="caps pb-1 pr-3 text-right font-medium">This run</th>
              <th className="caps pb-1 text-right font-medium">Illustrative manual workflow</th>
            </tr>
          </thead>
          <tbody>
            <Row
              label="Disruption cost"
              value={formatEur(k.totalCostEur.value)}
              base={
                baseline
                  ? `${formatEur(baseline.totalCostEur.value)} (${signed(k.totalCostEur.value - baseline.totalCostEur.value, formatEur)})`
                  : undefined
              }
              better={baseline ? k.totalCostEur.value < baseline.totalCostEur.value : null}
            />
            <Row
              label="Satisfaction"
              value={`${Math.round(k.satisfaction.value)}`}
              base={baseline ? `${Math.round(baseline.satisfaction.value)}` : undefined}
              better={baseline ? k.satisfaction.value > baseline.satisfaction.value : null}
            />
            <Row
              label="Margin to 3 h"
              value={formatDuration(k.minutesTo3h)}
              base={baseline ? formatDuration(baseline.minutesTo3h) : undefined}
              better={baseline ? k.minutesTo3h > baseline.minutesTo3h : null}
            />
            <Row
              label="First passenger message"
              value={
                k.latency.value.firstPaxMessageMin === null
                  ? '—'
                  : `m${k.latency.value.firstPaxMessageMin.toFixed(0)}`
              }
              base={
                baseline?.latency.value.firstPaxMessageMin != null
                  ? `m${baseline.latency.value.firstPaxMessageMin.toFixed(0)}`
                  : undefined
              }
              better={
                baseline?.latency.value.firstPaxMessageMin != null &&
                k.latency.value.firstPaxMessageMin !== null
                  ? k.latency.value.firstPaxMessageMin < baseline.latency.value.firstPaxMessageMin
                  : null
              }
            />
          </tbody>
        </table>
      )}
      <h3 className="caps mt-4 text-fg-muted">Decisions taken ({decisions.length})</h3>
      <ul
        tabIndex={0}
        aria-label="Decisions taken"
        className="mt-1 flex max-h-32 flex-col gap-1 overflow-y-auto text-caption"
      >
        {decisions.map((a) => (
          <li key={a.approvalId} className="flex gap-2">
            <Icon
              name={a.decision?.decision === 'reject' ? 'x' : 'check'}
              size={12}
              className="mt-0.5 shrink-0 text-fg-subtle"
            />
            <span className="min-w-0 flex-1 truncate text-fg-muted" title={a.summary}>
              {humaniseTool(a.tool)} — {a.decision?.decision}
            </span>
            <span className="shrink-0 text-fg-subtle">{actorLabel(a.decision?.decidedBy)}</span>
          </li>
        ))}
      </ul>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button variant="primary" icon="download" onClick={onExportPdf} disabled={exporting === 'pdf'}>
          {exporting === 'pdf' ? 'Rendering…' : 'Evidence pack (PDF)'}
        </Button>
        <Button icon="file" onClick={onExportJson} disabled={exporting === 'json'}>
          {exporting === 'json' ? 'Exporting…' : 'JSON trace'}
        </Button>
      </div>
    </motion.section>
  );
}
