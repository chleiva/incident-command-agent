/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * The airworthiness decision at a glance (task 06 §1.2, §1.6):
 * - the model's interpretation of the defect only as "Provisional reading — unconfirmed" (never a status);
 * - "Decided by": populated ONLY from the human decision recorded with `record_engineering_decision` (its
 *   `decidedBy` is the approving person); "Awaiting certifying staff" until that exists, never from agent text;
 * - the maintenance record, with every missing field shown as "Unknown" (never a default such as passed or OK).
 */
import {
  UNKNOWN,
  type Aircraft,
  type EngineeringDecision,
  type ProvisionalReading,
  type WorkOrder,
} from '@ica/schema/browser';
import { Term } from '../../glossary/Term';
import { humaniseTool } from '../../lib/format';
import { ProvisionalReadingBlock } from '../agents/PolicyCards';
import { Icon } from '../ui/Icon';
import { StateFrame, cx, type LoadStatus } from '../ui/primitives';

const DECISION_LABEL: Record<EngineeringDecision['decision'], string> = {
  rectify: 'Rectify before flight',
  defer_mel: 'Defer under the MEL',
  aog: 'AOG',
  release: 'Released to service',
};

export function decidedByLabel(d: EngineeringDecision | null | undefined): string {
  if (!d || d.decidedBy.kind !== 'human') return 'Awaiting certifying staff';
  return `${d.decidedBy.roleTitle} — ${d.decidedBy.name}`;
}

export function AirworthinessPanel({
  aircraft,
  reading,
  decision,
  workOrders,
  status = 'ready',
  error,
  className,
}: {
  aircraft: Aircraft | null;
  reading: ProvisionalReading | null;
  /** From `record_engineering_decision` only (mne.decisions). */
  decision: EngineeringDecision | null;
  workOrders: WorkOrder[];
  status?: LoadStatus;
  error?: string | null;
  className?: string;
}) {
  const record = aircraft?.maintenance;
  const lastCheck =
    record?.lastCheckType || record?.lastCheckDate
      ? [record?.lastCheckType ?? UNKNOWN, record?.lastCheckDate ?? UNKNOWN].join(' · ')
      : UNKNOWN;
  const history = record?.defectHistory?.length ? record.defectHistory.join('; ') : UNKNOWN;
  const wo = workOrders.filter((w) => !aircraft || w.tail === aircraft.tail).at(-1);
  return (
    <StateFrame status={status} error={error} empty={!aircraft} emptyText="No aircraft yet.">
      <section
        aria-label="Airworthiness decision"
        data-airworthiness
        className={cx('flex flex-col gap-1.5 text-caption', className)}
      >
        <h3 className="caps flex items-center gap-1 text-fg-muted">
          <Icon name="wrench" size={12} /> Airworthiness · {aircraft?.tail}
        </h3>
        {reading ? (
          <ProvisionalReadingBlock reading={reading} />
        ) : (
          <p className="text-fg-subtle">No provisional reading from the maintenance agent yet.</p>
        )}
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5">
          <dt className="text-fg-subtle">Decided by</dt>
          <dd data-decided-by className={decision ? 'font-medium text-fg' : 'text-warning'}>
            {decision ? (
              decidedByLabel(decision)
            ) : (
              <>
                Awaiting <Term term="certifying staff">certifying staff</Term>
              </>
            )}
          </dd>
          {decision && (
            <>
              <dt className="text-fg-subtle">Decision</dt>
              <dd className="text-fg">
                {decision.decision === 'aog' ? <Term term="AOG" /> : DECISION_LABEL[decision.decision]}{' '}
                <span className="text-fg-subtle">
                  (recorded with {humaniseTool('record_engineering_decision')})
                </span>
              </dd>
            </>
          )}
          <dt className="text-fg-subtle">Last check</dt>
          <dd className={lastCheck === UNKNOWN ? 'text-fg-subtle' : 'text-fg-muted'}>{lastCheck}</dd>
          <dt className="text-fg-subtle">Defect history</dt>
          <dd className={history === UNKNOWN ? 'text-fg-subtle' : 'text-fg-muted'}>{history}</dd>
          <dt className="text-fg-subtle">Work order</dt>
          <dd className="text-fg-muted">
            {wo ? `${wo.id}: ${wo.status?.replace(/_/g, ' ') ?? UNKNOWN}` : 'None raised yet'}
          </dd>
        </dl>
      </section>
    </StateFrame>
  );
}
