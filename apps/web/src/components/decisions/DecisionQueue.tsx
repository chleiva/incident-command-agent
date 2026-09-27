/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** "What needs me?" Pending proposals, most urgent first; recently decided ones below, with their approvers. */
import type { ApprovalDecisionRequest, ProjectedApproval } from '@ica/schema/browser';
import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useRef, useState } from 'react';
import { useUi, type OptimisticDecision } from '../../store/ui';
import { Icon } from '../ui/Icon';
import { StateFrame, type LoadStatus } from '../ui/primitives';
import { InvalidationNotice } from '../agents/PolicyCards';
import { DecisionCard } from './DecisionCard';

export function DecisionQueue({
  pending,
  decided,
  nowMinute,
  optimistic = {},
  onDecide,
  status = 'ready',
  error,
  announce = true,
  invalidated = [],
}: {
  /** Approvals invalidated by a changed assumption whose revision is not decided yet. */
  invalidated?: ProjectedApproval[];
  pending: ProjectedApproval[];
  decided: ProjectedApproval[];
  nowMinute: number;
  optimistic?: Record<string, OptimisticDecision>;
  onDecide: (approvalId: string, req: ApprovalDecisionRequest) => void;
  status?: LoadStatus;
  error?: string | null;
  announce?: boolean;
}) {
  const say = useUi((s) => s.announce);
  const seen = useRef<Set<string> | null>(null);
  const [showDecided, setShowDecided] = useState(false);

  // Live-region announcement for each new decision (not for the initial hydration).
  useEffect(() => {
    const ids = new Set(pending.map((p) => p.approvalId));
    if (seen.current && announce) {
      const fresh = pending.filter((p) => !seen.current!.has(p.approvalId));
      if (fresh.length) say(`Decision needed: ${fresh.map((f) => f.summary).join('; ')}`);
    }
    seen.current = ids;
  }, [pending, say, announce]);

  return (
    <StateFrame status={status} error={error}>
      <div className="flex flex-col gap-2">
        {invalidated.map((a) => (
          <InvalidationNotice
            key={a.approvalId}
            invalidation={{
              approvalId: a.approvalId,
              affectedAssumptions: a.invalidated!.affectedAssumptions,
            }}
            proposal={{ summary: a.summary, tool: a.tool }}
            revisionPending={!!a.supersededBy}
          />
        ))}
        {pending.length === 0 ? (
          <p className="flex items-center gap-2 rounded-md border border-dashed border-border px-3 py-3 text-body text-fg-subtle">
            <Icon name="check" size={14} /> Nothing needs you right now.
          </p>
        ) : (
          <ol className="flex flex-col gap-2" aria-label="Pending decisions, most urgent first">
            <AnimatePresence initial={false}>
              {pending.map((a) => (
                <motion.li
                  key={a.approvalId}
                  layout
                  initial={{ opacity: 0, x: 16 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.25, ease: [0.2, 0, 0, 1] }}
                >
                  <DecisionCard
                    approval={a}
                    nowMinute={nowMinute}
                    optimistic={optimistic[a.approvalId]}
                    onDecide={(req) => onDecide(a.approvalId, req)}
                  />
                </motion.li>
              ))}
            </AnimatePresence>
          </ol>
        )}
        {decided.length > 0 && (
          <div>
            <button
              type="button"
              aria-expanded={showDecided}
              onClick={() => setShowDecided(!showDecided)}
              className="inline-flex items-center gap-1 text-caption text-fg-muted hover:text-fg"
            >
              <Icon name={showDecided ? 'chevronDown' : 'chevronRight'} size={12} />
              {decided.length} decided
            </button>
            {showDecided && (
              <ul className="mt-2 flex flex-col gap-2">
                {decided.slice(0, 6).map((a) => (
                  <li key={a.approvalId}>
                    <DecisionCard approval={a} nowMinute={nowMinute} onDecide={() => {}} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </StateFrame>
  );
}
