/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * One pending proposal: plain-language summary, countdown, requesting agent and tier; the agent's reasoning on
 * expand; Approve / Edit (inline diff) / Reject (reason required). Keyboard A / E / R while the card has focus.
 * After the decision it shows the approver's name and role.
 */
import type { ApprovalDecisionRequest, ProjectedApproval } from '@ica/schema/browser';
import { useId, useRef, useState, type KeyboardEvent } from 'react';
import { GlossaryText, Term } from '../../glossary/Term';
import { InvalidationNotice } from '../agents/PolicyCards';
import { ROLE_LABEL, actorLabel, formatDuration, humaniseTool } from '../../lib/format';
import type { OptimisticDecision } from '../../store/ui';
import { AgentMark } from '../agents/AgentMark';
import { ArgsList } from '../agents/ArgValue';
import { Icon } from '../ui/Icon';
import { AiDraftedBadge, ApproverLine, Badge, Button, Kbd, TierBadge, cx, type Tone } from '../ui/primitives';
import { DiffEditor } from './DiffEditor';
import { OptionsMatrix } from './OptionsMatrix';
import { ProvenancePanel } from './Provenance';

type Mode = 'idle' | 'editing' | 'rejecting';

const ROLE_TITLES = ['Duty Manager', 'Certifying Engineer (B1)', 'Commander'] as const;

/** Tools whose decision belongs to certifying staff (spec §11). */
const CERTIFYING_TOOLS = new Set(['record_engineering_decision']);

/** Approving a swap sends a request to OCC; OCC confirms and executes it (task 06 §1.4). */
export const SWAP_APPROVE_LABEL = 'Send swap request to OCC';
export const SWAP_BODY =
  'Approving sends this swap request to Operations Control; OCC confirms and executes.';

export function urgency(a: ProjectedApproval, nowMinute: number): { text: string; tone: Tone } {
  if (a.expiresAtMinute !== undefined) {
    const left = a.expiresAtMinute - nowMinute;
    if (left <= 0) return { text: `overdue ${formatDuration(-left)}`, tone: 'critical' };
    return { text: `${formatDuration(left)} left`, tone: left < 5 ? 'warning' : 'neutral' };
  }
  const age = Math.max(0, nowMinute - a.createdAtMinute);
  return {
    text: age < 1 ? 'just now' : `waiting ${formatDuration(age)}`,
    tone: age > 15 ? 'warning' : 'neutral',
  };
}

function ArgsPreview({ args }: { args: Record<string, unknown> }) {
  return <ArgsList args={args} omit={['body']} limit={5} />;
}

export function DecisionCard({
  approval,
  nowMinute,
  optimistic,
  onDecide,
}: {
  approval: ProjectedApproval;
  nowMinute: number;
  optimistic?: OptimisticDecision;
  onDecide: (req: ApprovalDecisionRequest) => void;
}) {
  const id = useId();
  const [mode, setMode] = useState<Mode>('idle');
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const certifying = CERTIFYING_TOOLS.has(approval.tool);
  const [roleTitle, setRoleTitle] = useState<string>(
    certifying ? 'Certifying Engineer (B1)' : 'Duty Manager',
  );
  const ref = useRef<HTMLElement>(null);
  const decided = approval.decision;
  const sending = optimistic?.state === 'sending' && !decided;
  const u = urgency(approval, nowMinute);
  const body = typeof approval.args.body === 'string' ? approval.args.body : null;
  const swap = approval.tool === 'propose_swap';
  const role = approval.role;

  const decide = (req: Omit<ApprovalDecisionRequest, 'roleTitle'>) => {
    onDecide({ ...req, roleTitle });
    setMode('idle');
  };
  const approve = () => decide({ decision: 'approve' });

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (decided || sending || e.metaKey || e.ctrlKey || e.altKey) return;
    const target = e.target as HTMLElement;
    if (target.closest('textarea, input, select')) return;
    const k = e.key.toLowerCase();
    if (k === 'a' && !approval.options?.length) {
      e.preventDefault();
      approve();
    } else if (k === 'e' && !approval.options?.length) {
      e.preventDefault();
      setMode('editing');
    } else if (k === 'r') {
      e.preventDefault();
      setMode('rejecting');
    }
  };

  if (decided) {
    const verb =
      decided.decision === 'approve'
        ? 'Approved'
        : decided.decision === 'edit'
          ? 'Edited and approved'
          : 'Rejected';
    const option = decided.selectedOptionId
      ? approval.options?.find((o) => o.id === decided.selectedOptionId)
      : undefined;
    return (
      <article
        aria-label={`${verb}: ${approval.summary}`}
        data-decided={approval.approvalId}
        className="rounded-md border border-border bg-surface-sunken px-3 py-2"
      >
        <div className="flex items-center gap-2 text-caption">
          <Icon
            name={decided.decision === 'reject' ? 'x' : 'check'}
            size={12}
            className={decided.decision === 'reject' ? 'text-fg-muted' : 'text-good'}
          />
          <span className="text-fg-muted">{verb}</span>
          <span className="ml-auto text-fg-subtle">{humaniseTool(approval.tool)}</span>
        </div>
        <p className="mt-1 line-clamp-2 text-body text-fg-muted">
          {option ? option.label : approval.summary}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-x-2">
          <ApproverLine
            actor={decided.decidedBy}
            prefix={decided.decision === 'reject' ? 'Rejected by' : 'Approved by'}
          />
          {decided.reason && <span className="text-caption text-fg-subtle">“{decided.reason}”</span>}
        </div>
        {approval.invalidated && (
          <div className="mt-2">
            <InvalidationNotice
              invalidation={{
                approvalId: approval.approvalId,
                affectedAssumptions: approval.invalidated.affectedAssumptions,
              }}
            />
          </div>
        )}
      </article>
    );
  }

  return (
    <article
      ref={ref}
      tabIndex={0}
      onKeyDown={onKeyDown}
      data-approval={approval.approvalId}
      aria-labelledby={`${id}-summary`}
      aria-describedby={`${id}-meta`}
      className={cx(
        'rounded-lg border bg-surface-raised p-3 shadow-e2 outline-none transition-colors focus-visible:border-focus',
        u.tone === 'critical'
          ? 'border-critical/70'
          : u.tone === 'warning'
            ? 'border-warning/60'
            : 'border-border-control/50',
      )}
    >
      <header id={`${id}-meta`} className="flex items-center gap-2">
        {role && <AgentMark role={role} size={20} />}
        <span className="truncate text-caption text-fg-muted">
          {role ? `${ROLE_LABEL[role]} agent` : 'Agent'}
        </span>
        <TierBadge tier="propose" />
        <span
          className={cx(
            'num ml-auto inline-flex shrink-0 items-center gap-1 text-caption',
            u.tone === 'critical' ? 'text-critical' : u.tone === 'warning' ? 'text-warning' : 'text-fg-muted',
          )}
        >
          <Icon name="clock" size={12} />
          {u.text}
        </span>
      </header>

      {approval.supersedesApprovalId && (
        <p className="mt-2">
          <Badge tone="warning" icon="edit">
            Revised after an invalidated approval
          </Badge>
        </p>
      )}
      <p id={`${id}-summary`} className="mt-2 text-body-lg text-fg">
        <GlossaryText text={approval.summary} />
      </p>
      <p className="mt-0.5 font-mono text-micro text-fg-subtle">{approval.tool}</p>
      {swap && (
        <p data-swap-note className="mt-1 text-caption text-fg">
          <GlossaryText text={SWAP_BODY} />
        </p>
      )}

      {body && (
        <figure className="mt-2 rounded-md border border-border bg-surface-sunken p-2">
          <figcaption className="mb-1 flex items-center gap-2">
            <AiDraftedBadge />
            <span className="text-micro text-fg-subtle">Message to passengers</span>
          </figcaption>
          <p className="text-caption text-fg">
            <GlossaryText text={body} />
          </p>
        </figure>
      )}

      {approval.options && approval.options.length > 0 && (
        <div className="mt-2">
          <OptionsMatrix
            options={approval.options}
            disabled={sending}
            selectedId={optimistic?.selectedOptionId}
            createdAtMinute={approval.createdAtMinute}
            onSelect={(optionId) => decide({ decision: 'approve', selectedOptionId: optionId })}
          />
        </div>
      )}

      {!approval.options?.length && (
        <div className="mt-2">
          <ArgsPreview args={approval.args} />
        </div>
      )}

      <ProvenancePanel
        className="mt-2"
        createdAtMinute={approval.createdAtMinute}
        dataAsOfMinute={approval.dataAsOfMinute}
        citations={approval.citations}
        unresolvedChecks={approval.unresolvedChecks}
        approvalScope={approval.approvalScope}
      />

      <button
        type="button"
        aria-expanded={open}
        aria-controls={`${id}-why`}
        onClick={() => setOpen(!open)}
        className="mt-2 inline-flex items-center gap-1 text-caption text-fg-muted hover:text-fg"
      >
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} /> Agent’s reasoning
      </button>
      {open && (
        <div id={`${id}-why`} className="mt-1 rounded-md bg-surface-sunken p-2 text-caption text-fg-muted">
          <div className="mb-1">
            <AiDraftedBadge />
          </div>
          <GlossaryText text={approval.reasoning} />
        </div>
      )}

      {certifying && (
        <div className="mt-2 flex items-center gap-2 rounded-md bg-warning-bg px-2 py-1 text-caption text-fg">
          <Icon name="shield" size={12} className="text-warning" />
          <span>
            Reserved for <Term term="certifying staff">certifying staff</Term>.
          </span>
          <label className="ml-auto flex items-center gap-1 text-fg-muted">
            <span className="sr-only">Approving as</span>
            <select
              value={roleTitle}
              onChange={(e) => setRoleTitle(e.target.value)}
              className="rounded-sm border border-border-control/60 bg-surface-raised px-1 text-caption text-fg"
            >
              {ROLE_TITLES.map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
          </label>
        </div>
      )}

      {certifying && (
        <p data-decided-by className="mt-1 text-caption text-fg-muted">
          Decided by: <span className="text-fg">Awaiting certifying staff</span>
        </p>
      )}

      {sending ? (
        <p role="status" className="mt-3 inline-flex items-center gap-2 text-caption text-fg-muted">
          <span className="h-2 w-2 animate-soft-pulse rounded-full bg-fg-muted" aria-hidden />
          Decided ({optimistic?.decision}) — sending…
        </p>
      ) : mode === 'editing' ? (
        <div className="mt-3">
          <DiffEditor
            original={approval.args}
            onCancel={() => setMode('idle')}
            onSubmit={(editedArgs) => decide({ decision: 'edit', editedArgs })}
          />
        </div>
      ) : mode === 'rejecting' ? (
        <form
          className="mt-3 flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (reason.trim()) decide({ decision: 'reject', reason: reason.trim() });
          }}
        >
          <label htmlFor={`${id}-reason`} className="caps text-fg-muted">
            Reason for rejecting (required)
          </label>
          <textarea
            id={`${id}-reason`}
            autoFocus
            required
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="w-full rounded-md border border-border-control/70 bg-surface-sunken p-2 text-body text-fg"
          />
          <div className="flex gap-2">
            <Button type="submit" variant="danger" size="sm" disabled={!reason.trim()}>
              Reject
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setMode('idle')}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {!approval.options?.length && (
            <>
              <Button variant="approve" size="sm" onClick={approve} aria-keyshortcuts="A">
                {swap ? SWAP_APPROVE_LABEL : 'Approve'}{' '}
                <Kbd className="border-on-good/40 text-on-good">A</Kbd>
              </Button>
              <Button size="sm" onClick={() => setMode('editing')} aria-keyshortcuts="E">
                Edit <Kbd>E</Kbd>
              </Button>
            </>
          )}
          <Button variant="danger" size="sm" onClick={() => setMode('rejecting')} aria-keyshortcuts="R">
            Reject <Kbd className="border-critical/50 text-critical">R</Kbd>
          </Button>
          {optimistic?.state === 'error' && (
            <Badge tone="critical" icon="alert">
              Not sent — try again
            </Badge>
          )}
        </div>
      )}
      <p className="sr-only">Requested by {role ? actorLabel({ kind: 'agent', role }) : 'an agent'}.</p>
    </article>
  );
}
