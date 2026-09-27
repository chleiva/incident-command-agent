/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** "Who is affected?" Passenger cohorts with their information and care status. */
import type { Cohort, CohortKind } from '@ica/schema/browser';
import { GlossaryText } from '../../glossary/Term';
import { formatInt, formatUtc } from '../../lib/format';
import { Icon, type IconName } from '../ui/Icon';
import { StateFrame, cx, type LoadStatus } from '../ui/primitives';

const KIND: Record<CohortKind, { label: string; icon: IconName }> = {
  connections: { label: 'Connections', icon: 'plane' },
  prm: { label: 'PRM', icon: 'user' },
  families: { label: 'Families', icon: 'users' },
  unaccompanied_minors: { label: 'Minors (UM)', icon: 'user' },
  general: { label: 'General', icon: 'users' },
  premium: { label: 'Premium', icon: 'user' },
};

const PRIORITY: CohortKind[] = [
  'unaccompanied_minors',
  'prm',
  'connections',
  'families',
  'premium',
  'general',
];

const STATUS_LABEL: Record<Cohort['status'], string> = {
  uninformed: 'Not informed',
  informed: 'Informed',
  care_issued: 'Care issued',
  rebooked: 'Rebooked',
  waiting: 'Waiting',
};

export function CohortBoard({
  cohorts,
  nowMinute,
  triggerMinute = 0,
  status = 'ready',
  error,
}: {
  cohorts: Cohort[];
  nowMinute: number;
  triggerMinute?: number;
  status?: LoadStatus;
  error?: string | null;
}) {
  const sorted = [...cohorts].sort((a, b) => PRIORITY.indexOf(a.kind) - PRIORITY.indexOf(b.kind));
  const total = cohorts.reduce((n, c) => n + c.count, 0);
  return (
    <StateFrame
      status={status}
      error={error}
      empty={cohorts.length === 0}
      emptyText="No passenger cohorts in this run."
    >
      <div className="flex flex-col gap-2">
        <p className="num text-caption text-fg-subtle">
          {formatInt(total)} passengers · {cohorts.length} cohorts
        </p>
        <ul
          className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-2"
          aria-label="Passenger cohorts"
        >
          {sorted.map((c) => {
            const late = c.status === 'uninformed' && nowMinute - triggerMinute > 15;
            return (
              <li
                key={c.id}
                className={cx(
                  'flex min-w-0 flex-col gap-1 rounded-md border px-2 py-2',
                  late ? 'border-warning/60 bg-warning-bg' : 'border-border bg-surface-raised',
                )}
              >
                <div className="flex items-center gap-1">
                  <Icon name={KIND[c.kind].icon} size={12} className="text-fg-subtle" />
                  <span className="truncate text-caption text-fg-muted">
                    <GlossaryText text={KIND[c.kind].label} />
                  </span>
                  <span className="num ml-auto text-title font-semibold text-fg">{formatInt(c.count)}</span>
                </div>
                <div className="flex items-center gap-1 text-caption">
                  <Icon
                    name={c.status === 'uninformed' ? (late ? 'alert' : 'clock') : 'check'}
                    size={12}
                    className={
                      late ? 'text-warning' : c.status === 'uninformed' ? 'text-fg-subtle' : 'text-fg-muted'
                    }
                  />
                  <span className={late ? 'text-warning' : 'text-fg-muted'}>
                    {STATUS_LABEL[c.status]}
                    {c.firstInformedAtMinute !== undefined && c.status !== 'uninformed'
                      ? ` · m${Math.round(c.firstInformedAtMinute)}`
                      : ''}
                  </span>
                </div>
                {(c.notes || c.onwardDeadline || c.careIssued > 0 || c.rebookedTo) && (
                  <p className="truncate text-micro text-fg-subtle" title={c.notes}>
                    {[
                      c.careIssued > 0 ? `${c.careIssued} vouchers` : null,
                      c.rebookedTo ? `rebooked ${c.rebookedTo}` : null,
                      c.onwardDeadline ? `onward by ${formatUtc(c.onwardDeadline)}Z` : null,
                      c.notes,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </StateFrame>
  );
}
