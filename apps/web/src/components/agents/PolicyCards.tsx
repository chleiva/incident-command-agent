/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Cards for authority and change events in the agent stream (task 06):
 * - `BlockedActionCard`: a forbidden call refused by the tier gate, "Blocked by autonomy policy", with the tool, the
 *   reason, the rule and who holds the authority (presenter-triggered demonstrations are labelled as such);
 * - `InvalidationNotice`: "Approval invalidated", listing the assumptions that changed (was → now);
 * - `ProvisionalReadingBlock`: a model's reading of a defect, labelled verbatim "Provisional reading — unconfirmed".
 */
import {
  PROVISIONAL_READING_LABEL,
  type EventPayloadMap,
  type ProvisionalReading,
} from '@ica/schema/browser';
import { GlossaryText, Term } from '../../glossary/Term';
import { humaniseTool } from '../../lib/format';
import { Icon } from '../ui/Icon';
import { Badge, cx } from '../ui/primitives';

/** Fallback for events recorded before `rule`/`authority` were added (mirrors the runtime's FORBIDDEN_RULES). */
export const AUTHORITY_FALLBACK: Record<string, { rule: string; authority: string }> = {
  defer_defect: {
    rule: 'Deferral under the MEL is a certifying-staff decision (Part-145 / ORO.MLR.105)',
    authority: 'Certifying staff',
  },
  release_aircraft: {
    rule: 'Release to service needs a certificate of release by certifying staff (145.A.50)',
    authority: 'Certifying staff',
  },
  extend_crew_fdp: {
    rule: "Extending a flight duty period is the commander's discretion (ORO.FTL.205(f))",
    authority: 'Aircraft commander',
  },
};

export function BlockedActionCard({
  block,
  className,
}: {
  block: Pick<
    EventPayloadMap['guardrail.blocked'],
    'tool' | 'reason' | 'rule' | 'authority' | 'presenterTriggered'
  >;
  className?: string;
}) {
  const fallback = block.tool ? AUTHORITY_FALLBACK[block.tool] : undefined;
  const rule = block.rule ?? fallback?.rule;
  const authority = block.authority ?? fallback?.authority;
  return (
    <section
      data-blocked-card
      aria-label="Blocked by autonomy policy"
      className={cx('rounded-md border border-warning/60 bg-warning-bg p-2 text-caption text-fg', className)}
    >
      <header className="flex flex-wrap items-center gap-2">
        <Icon name="shield" size={14} className="text-warning" />
        <span className="font-semibold">Blocked by autonomy policy</span>
        {block.presenterTriggered && (
          <Badge tone="neutral" icon="user">
            Presenter-triggered demonstration
          </Badge>
        )}
      </header>
      <dl className="mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5">
        <dt className="text-fg-subtle">Tool</dt>
        <dd>
          {block.tool ? humaniseTool(block.tool) : 'unknown'}{' '}
          {block.tool && <span className="font-mono text-micro text-fg-subtle">{block.tool}</span>}
        </dd>
        <dt className="text-fg-subtle">Reason</dt>
        <dd className="text-fg-muted">
          <GlossaryText text={block.reason} />
        </dd>
        {rule && (
          <>
            <dt className="text-fg-subtle">Rule</dt>
            <dd className="text-fg-muted">
              <GlossaryText text={rule} />
            </dd>
          </>
        )}
        {authority && (
          <>
            <dt className="text-fg-subtle">Who decides</dt>
            <dd className="font-medium">
              <Term term={authority}>{authority}</Term>
            </dd>
          </>
        )}
      </dl>
      <p className="mt-1 text-micro text-fg-subtle">
        Enforced in code by the tier gate; nothing was changed.
      </p>
    </section>
  );
}

const KEY_LABEL: Record<string, string> = {
  engineerEtaMinute: 'Engineer ETA',
  spareAvailableFromMinute: 'Spare available from',
};

export function assumptionLabel(key: string): string {
  const [base, id] = key.split(':');
  const label = KEY_LABEL[base!] ?? base!;
  return id ? `${label} (${id})` : label;
}

function formatValue(key: string, v: unknown, clock?: (m: number) => string): string {
  if (v === null || v === undefined) return 'Unknown';
  if (typeof v === 'number' && /Minute/.test(key))
    return clock ? `${clock(v)}Z (min ${v.toFixed(0)})` : `min ${v.toFixed(0)}`;
  return String(v);
}

export function InvalidationNotice({
  invalidation,
  proposal,
  clock,
  revisionPending,
}: {
  invalidation: Pick<EventPayloadMap['approval.invalidated'], 'approvalId' | 'affectedAssumptions'>;
  proposal?: { summary: string; tool: string };
  clock?: (m: number) => string;
  /** True while the revised proposal waits for a decision. */
  revisionPending?: boolean;
}) {
  return (
    <section
      data-invalidation={invalidation.approvalId}
      aria-label="Approval invalidated"
      className="rounded-md border border-critical/50 bg-critical-bg p-2 text-caption text-fg"
    >
      <header className="flex items-center gap-2">
        <Icon name="alert" size={14} className="text-critical" />
        <span className="font-semibold">Approval invalidated</span>
        {revisionPending !== undefined && (
          <span className="ml-auto text-micro text-fg-muted">
            {revisionPending ? 'Revised proposal awaiting you' : 'Re-gathering evidence…'}
          </span>
        )}
      </header>
      {proposal && (
        <p className="mt-1 text-fg-muted">
          <GlossaryText text={proposal.summary} />
        </p>
      )}
      <p className="mt-1 text-fg-subtle">An assumption it relied on changed:</p>
      <ul className="mt-0.5 flex flex-col gap-0.5">
        {invalidation.affectedAssumptions.map((a) => (
          <li key={a.key} className="num">
            <span className="text-fg-muted">{assumptionLabel(a.key)}: </span>
            <span className="line-through decoration-fg-subtle">{formatValue(a.key, a.was, clock)}</span>
            {' → '}
            <span className="font-semibold">{formatValue(a.key, a.now, clock)}</span>
          </li>
        ))}
      </ul>
      <p className="mt-1 text-micro text-fg-subtle">
        The agent re-gathers the evidence and issues a revised proposal for your decision.
      </p>
    </section>
  );
}

export function ProvisionalReadingBlock({ reading }: { reading: ProvisionalReading }) {
  return (
    <figure
      data-provisional-reading
      className="rounded-md border border-dashed border-ai/60 bg-ai-bg px-2 py-1.5 text-caption"
    >
      <figcaption className="flex items-center gap-2 text-micro font-semibold text-ai">
        {PROVISIONAL_READING_LABEL}
        {reading.confidence && (
          <span className="font-normal text-fg-subtle">confidence: {reading.confidence}</span>
        )}
      </figcaption>
      <p className="mt-0.5 text-fg">
        <GlossaryText text={reading.text} />
      </p>
    </figure>
  );
}
