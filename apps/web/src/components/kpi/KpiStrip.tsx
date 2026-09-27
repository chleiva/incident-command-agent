/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** Row 1: "How bad is it?" Six KPI tiles, each explainable. */
import type { KpiSnapshot } from '@ica/schema/browser';
import type { KpiPoint } from '../../lib/derive';
import { Skeleton, cx, type LoadStatus } from '../ui/primitives';
import { KPI_TILES, tileModels, type KpiTileKey, type SafetyContext } from './kpiModel';
import { KpiTile } from './KpiTile';

const LABELS: Record<KpiTileKey, string> = {
  clock: 'Incident clock',
  countdown: 'To 3-hour threshold',
  cost: 'Disruption cost (estimate)',
  satisfaction: 'Passenger satisfaction (estimate)',
  compliance: 'Compliance',
  safety: 'Safety gates',
};

export function KpiStrip({
  kpis,
  series,
  baseline = null,
  status = 'ready',
  error,
  onOpen,
  dense = false,
  label = 'Key indicators',
  safety,
  baselineSafety,
}: {
  kpis: KpiSnapshot | null;
  series: KpiPoint[];
  baseline?: KpiSnapshot | null;
  status?: LoadStatus;
  error?: string | null;
  onOpen?: (key: KpiTileKey) => void;
  dense?: boolean;
  label?: string;
  /** Approval context the snapshot may lack (auto-approved gated actions, derived from the projection). */
  safety?: SafetyContext;
  baselineSafety?: SafetyContext;
}) {
  const grid = 'grid grid-cols-3 gap-2 xl:grid-cols-6';
  if (status === 'loading') {
    return (
      <div className={grid} role="status" aria-label="Loading indicators">
        {KPI_TILES.map((k) => (
          <Skeleton key={k} className={dense ? 'h-16' : 'h-20'} />
        ))}
      </div>
    );
  }
  if (status === 'error' || !kpis) {
    return (
      <div className={grid} role={status === 'error' ? 'alert' : undefined} aria-label={label}>
        {KPI_TILES.map((k) => (
          <div
            key={k}
            className={cx(
              'flex flex-col justify-between gap-2 rounded-lg border border-border bg-surface px-3 py-2',
              dense ? 'h-16' : 'h-20',
            )}
          >
            <span className="caps text-fg-muted">{LABELS[k]}</span>
            <span className="text-caption text-fg-subtle">
              {status === 'error' ? (error ?? 'Unavailable') : 'Waiting for the first snapshot'}
            </span>
          </div>
        ))}
      </div>
    );
  }
  const models = tileModels(kpis, baseline, safety, baselineSafety);
  return (
    <div className={grid} role="group" aria-label={label}>
      {models.map((m) => (
        <KpiTile key={m.key} model={m} kpis={kpis} series={series} onOpen={onOpen} dense={dense} />
      ))}
    </div>
  );
}
