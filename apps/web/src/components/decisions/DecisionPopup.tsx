/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * The gentle decision popup: a non-blocking floating card (bottom-right) for the most urgent LIVE pending decision,
 * one at a time with "{n} more waiting". It never traps focus or blocks the page; new decisions are announced in a
 * polite live region; `D` focuses it and A / E / R work while it has focus. Approve · Edit (the DiffEditor) ·
 * Reject (a reason is required).
 *
 * Auto-approval is OFF by default: the card waits for the viewer, with a presenter hint ("Press Space to pause the
 * clock while you decide"). Only when the viewer turns it on in ⌘K does a visible 10 s countdown ("Approving
 * automatically in {s}s") approve the decision as `{kind:'policy', policy:'simulation-auto'}`. It pauses while the
 * card is hovered or focused (WCAG 2.2.1) and resumes on leave; it is cancelled for good once the viewer starts
 * editing or rejecting, or decides manually. A 409 (decided elsewhere first) closes the card gracefully.
 */
import type { ApprovalDecisionRequest, ProjectedApproval } from '@ica/schema/browser';
import * as Tooltip from '@radix-ui/react-tooltip';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type Ref,
} from 'react';
import { toolLabel } from '../../agents/headline';
import { roleShortName } from '../../agents/roles';
import type { DecideOutcome } from '../../app/actions';
import { GlossaryText } from '../../glossary/Term';
import {
  AUTO_APPROVE_EXPLAINER,
  AUTO_APPROVE_MS,
  AUTO_APPROVE_OFF_EXPLAINER,
  autoApproveRequest,
  recommendedOptionId,
} from '../../lib/autoApprove';
import type { OptimisticDecision } from '../../store/ui';
import { AgentMark } from '../agents/AgentMark';
import { Icon } from '../ui/Icon';
import { Badge, Button, Kbd, cx } from '../ui/primitives';
import { urgency } from './DecisionCard';
import { DiffEditor } from './DiffEditor';

type Mode = 'idle' | 'editing' | 'rejecting';

/** Tools whose decision belongs to certifying staff: a policy approval is refused by the system (in code). */
const CERTIFYING_TOOLS = new Set(['record_engineering_decision']);

/**
 * Countdown progress per approval, kept across remounts (dashboard ↔ Agents view) so switching pages does not
 * restart it; and the approvals the countdown has already fired for (never twice).
 */
const remainingById = new Map<string, number>();
const firedIds = new Set<string>();

/** Test/story helper: forget countdown progress. */
export function resetDecisionPopupState(): void {
  remainingById.clear();
  firedIds.clear();
}

export interface DecisionPopupProps {
  /** LIVE pending approvals, most urgent first (`pendingByUrgency(head)`). */
  pending: ProjectedApproval[];
  nowMinute: number;
  optimistic?: Record<string, OptimisticDecision>;
  /** Simulation auto-approval on (⌘K toggle, default OFF). */
  autoApprove: boolean;
  /** Countdown length (`AUTO_APPROVE_MS`; a test hook may shorten it in mock mode). */
  durationMs?: number;
  onDecide: (approvalId: string, req: ApprovalDecisionRequest) => Promise<DecideOutcome>;
  /** The viewer is in history mode at this minute: the card says it is live. */
  historyMinute?: number | null;
  /** Stories: start mid-countdown, paused, or in a mode. */
  initialRemainingMs?: number;
  forcePaused?: boolean;
  initialMode?: Mode;
  /** Stories/tests: no slide-in animation. */
  static?: boolean;
}

export function DecisionPopup({
  pending,
  nowMinute,
  optimistic = {},
  autoApprove,
  durationMs = AUTO_APPROVE_MS,
  onDecide,
  historyMinute = null,
  initialRemainingMs,
  forcePaused = false,
  initialMode,
  static: isStatic = false,
}: DecisionPopupProps) {
  const reduce = useReducedMotion();
  const rootRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLElement>(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [minimised, setMinimised] = useState(false);
  const [showQueue, setShowQueue] = useState(false);
  /** Sent from this card and not yet reconciled; closed after a 409. */
  const [inFlight, setInFlight] = useState<ReadonlySet<string>>(new Set());
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');

  const queue = useMemo(
    () =>
      pending.filter((a) => {
        const o = optimistic[a.approvalId];
        return (!o || o.state === 'error') && !inFlight.has(a.approvalId) && !closed.has(a.approvalId);
      }),
    [pending, optimistic, inFlight, closed],
  );
  // Keep the card the viewer is looking at stable; otherwise the most urgent.
  const current = queue.find((a) => a.approvalId === pickedId) ?? queue[0] ?? null;
  const currentId = current?.approvalId ?? null;
  useEffect(() => {
    if (currentId && currentId !== pickedId) setPickedId(currentId);
  }, [currentId, pickedId]);
  const rest = queue.filter((a) => a.approvalId !== currentId);

  // Announce each new card politely.
  const announced = useRef<string | null>(null);
  useEffect(() => {
    if (!current || announced.current === current.approvalId) return;
    announced.current = current.approvalId;
    const who = current.role ? `the ${roleShortName(current.role)} agent` : 'an agent';
    setAnnouncement(`Decision needed from ${who}: ${current.summary}. Press D to review it.`);
  }, [current]);

  // `D` focuses the card (and restores it when minimised), unless the viewer is typing.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.key.toLowerCase() !== 'd') return;
      const t = e.target as HTMLElement | null;
      if (t?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return;
      if (!currentId) return;
      e.preventDefault();
      setMinimised(false);
      requestAnimationFrame(() => cardRef.current?.focus());
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [currentId]);

  const decide = useCallback(
    async (approvalId: string, req: ApprovalDecisionRequest): Promise<DecideOutcome> => {
      setInFlight((s) => new Set(s).add(approvalId));
      const out = await onDecide(approvalId, req);
      setInFlight((s) => {
        const n = new Set(s);
        n.delete(approvalId);
        return n;
      });
      if (out === 'conflict') {
        setClosed((s) => new Set(s).add(approvalId));
        setAnnouncement('That decision was already taken elsewhere; the card closed.');
      } else if (out === 'ok' && req.policy === 'simulation-auto') {
        setAnnouncement('Auto-approved (simulation).');
      }
      if (out === 'ok') setClosed((s) => new Set(s).add(approvalId));
      return out;
    },
    [onDecide],
  );

  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
  };
  const paused = forcePaused || hovered || focused;

  return (
    <div
      ref={rootRef}
      data-decision-popup
      className="pointer-events-none fixed bottom-4 right-4 z-40 flex w-[380px] max-w-[calc(100vw-2rem)] flex-col items-end gap-2"
    >
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>
      <AnimatePresence initial={!isStatic}>
        {current && (
          <motion.div
            key="popup"
            className="pointer-events-auto w-full"
            initial={reduce || isStatic ? { opacity: 0 } : { opacity: 0, x: 24, y: 8 }}
            animate={{ opacity: 1, x: 0, y: 0 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, x: 24 }}
            transition={{ duration: reduce ? 0.01 : 0.28, ease: [0.2, 0, 0, 1] }}
            onPointerEnter={() => setHovered(true)}
            onPointerLeave={() => setHovered(false)}
            onFocus={() => setFocused(true)}
            onBlur={onBlur}
          >
            <PopupCard
              key={current.approvalId}
              ref={cardRef}
              approval={current}
              nowMinute={nowMinute}
              more={rest.length}
              autoApprove={autoApprove}
              durationMs={durationMs}
              paused={paused}
              minimised={minimised}
              onMinimise={setMinimised}
              showQueue={showQueue}
              onToggleQueue={() => setShowQueue(!showQueue)}
              queue={rest}
              onPick={(id) => {
                setPickedId(id);
                setShowQueue(false);
              }}
              historyMinute={historyMinute}
              failed={optimistic[current.approvalId]?.state === 'error'}
              decide={decide}
              initialRemainingMs={initialRemainingMs}
              initialMode={initialMode}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

interface PopupCardProps {
  approval: ProjectedApproval;
  nowMinute: number;
  more: number;
  autoApprove: boolean;
  durationMs: number;
  paused: boolean;
  minimised: boolean;
  onMinimise: (on: boolean) => void;
  showQueue: boolean;
  onToggleQueue: () => void;
  queue: ProjectedApproval[];
  onPick: (approvalId: string) => void;
  historyMinute: number | null;
  failed: boolean;
  decide: (approvalId: string, req: ApprovalDecisionRequest) => Promise<DecideOutcome>;
  initialRemainingMs?: number;
  initialMode?: Mode;
}

const PopupCard = forwardRef<HTMLElement, PopupCardProps>(function PopupCard(
  {
    approval,
    nowMinute,
    more,
    autoApprove,
    durationMs,
    paused,
    minimised,
    onMinimise,
    showQueue,
    onToggleQueue,
    queue,
    onPick,
    historyMinute,
    failed,
    decide,
    initialRemainingMs,
    initialMode = 'idle',
  },
  ref,
) {
  const id = useId();
  const approvalId = approval.approvalId;
  const [mode, setMode] = useState<Mode>(initialMode);
  const [reason, setReason] = useState('');
  /** The viewer engaged (edit, reject, a failed send): no automatic approval for this card any more. */
  const [engaged, setEngaged] = useState(initialMode !== 'idle' || failed);
  const [sending, setSending] = useState(false);
  const [optionId, setOptionId] = useState<string | undefined>(() => recommendedOptionId(approval));
  const [remaining, setRemaining] = useState(
    () => initialRemainingMs ?? remainingById.get(approvalId) ?? durationMs,
  );
  const certifying = CERTIFYING_TOOLS.has(approval.tool);
  const hasOptions = !!approval.options?.length;
  const agent = approval.role ? `${roleShortName(approval.role)} agent` : 'An agent';

  // Airworthiness decisions belong to certifying staff: never auto-approved, not even in the simulation.
  const countdownOn = autoApprove && !certifying && !engaged && !sending && mode === 'idle';
  const running = countdownOn && !paused && remaining > 0;

  useEffect(() => {
    if (!running) return;
    let last = Date.now();
    const t = setInterval(() => {
      const now = Date.now();
      const dt = now - last;
      last = now;
      setRemaining((r) => {
        const next = Math.max(0, r - dt);
        remainingById.set(approvalId, next);
        return next;
      });
    }, 100);
    return () => clearInterval(t);
  }, [running, approvalId]);

  const send = useCallback(
    async (req: ApprovalDecisionRequest) => {
      setSending(true);
      const out = await decide(approvalId, req);
      if (out === 'error') {
        setSending(false);
        setEngaged(true);
      }
    },
    [approvalId, decide],
  );

  // At zero (and not paused), approve through the normal approval route, once.
  useEffect(() => {
    if (!countdownOn || paused || remaining > 0 || firedIds.has(approvalId)) return;
    firedIds.add(approvalId);
    void send(autoApproveRequest(approval));
  }, [countdownOn, paused, remaining, approvalId, approval, send]);

  const roleTitle = certifying ? 'Certifying Engineer (B1)' : 'Duty Manager';
  const approve = () =>
    void send({
      decision: 'approve',
      roleTitle,
      ...(hasOptions && optionId ? { selectedOptionId: optionId } : {}),
    });
  const startEdit = () => {
    setEngaged(true);
    setMode('editing');
  };
  const startReject = () => {
    setEngaged(true);
    setMode('rejecting');
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (sending || e.metaKey || e.ctrlKey || e.altKey) return;
    if ((e.target as HTMLElement).closest('textarea, input, select')) return;
    const k = e.key.toLowerCase();
    if (mode !== 'idle') {
      if (e.key === 'Escape') {
        e.preventDefault();
        setMode('idle');
      }
      return;
    }
    if (k === 'a') {
      e.preventDefault();
      approve();
    } else if (k === 'e' && !hasOptions) {
      e.preventDefault();
      startEdit();
    } else if (k === 'r') {
      e.preventDefault();
      startReject();
    }
  };

  const seconds = Math.ceil(remaining / 1000);
  const u = urgency(approval, nowMinute);
  const scope = approval.approvalScope;

  if (minimised)
    return (
      <div className="flex justify-end">
        <button
          type="button"
          ref={ref as Ref<HTMLButtonElement>}
          onClick={() => onMinimise(false)}
          data-popup-approval={approvalId}
          aria-label={`Decision waiting: ${approval.summary}. Show the decision card.`}
          className="inline-flex items-center gap-2 rounded-full border border-warning/60 bg-surface-raised px-3 py-1.5 text-caption text-fg shadow-e3 outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          {countdownOn ? (
            <CountdownRing fraction={remaining / durationMs} size={16} />
          ) : (
            <Icon name="decision" size={14} className="text-warning" />
          )}
          Decision waiting{more ? ` · ${more} more` : ''}
          {countdownOn && <span className="num text-fg-muted">{seconds}s</span>}
        </button>
      </div>
    );

  return (
    <article
      ref={ref}
      tabIndex={0}
      onKeyDown={onKeyDown}
      data-popup-approval={approvalId}
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-summary`}
      aria-keyshortcuts="A E R"
      className="max-h-[70vh] overflow-y-auto rounded-lg border border-warning/50 bg-surface-raised p-3 shadow-e3 outline-none focus-visible:ring-2 focus-visible:ring-focus"
    >
      <header className="flex items-center gap-2">
        <Icon name="decision" size={14} className="text-warning" />
        <h2 id={`${id}-title`} className="text-body font-semibold text-fg">
          Decision needed
        </h2>
        {more > 0 && (
          <button
            type="button"
            aria-expanded={showQueue}
            aria-controls={`${id}-queue`}
            onClick={onToggleQueue}
            className="rounded-full bg-surface-hover px-2 py-0.5 text-micro text-fg-muted hover:text-fg"
            data-popup-more
          >
            {more} more waiting
          </button>
        )}
        <span
          className={cx(
            'num ml-auto text-micro',
            u.tone === 'critical'
              ? 'text-critical'
              : u.tone === 'warning'
                ? 'text-warning'
                : 'text-fg-subtle',
          )}
        >
          {u.text}
        </span>
        <button
          type="button"
          onClick={() => onMinimise(true)}
          aria-label="Minimise the decision card"
          title="Minimise (D brings it back)"
          className="inline-flex h-6 w-6 items-center justify-center rounded-md text-fg-muted hover:bg-surface-hover hover:text-fg"
        >
          <Icon name="collapse" size={12} />
        </button>
      </header>

      {showQueue && more > 0 && (
        <ol
          id={`${id}-queue`}
          className="mt-2 flex flex-col gap-1"
          aria-label="Also waiting, most urgent first"
        >
          {queue.map((q) => (
            <li key={q.approvalId}>
              <button
                type="button"
                onClick={() => onPick(q.approvalId)}
                className="w-full truncate rounded-md border border-border px-2 py-1 text-left text-caption text-fg-muted hover:bg-surface-hover hover:text-fg"
              >
                {q.role ? `${roleShortName(q.role)}: ` : ''}
                {q.summary}
              </button>
            </li>
          ))}
        </ol>
      )}

      <p className="mt-2 flex items-center gap-2 text-caption text-fg-muted">
        {approval.role && <AgentMark role={approval.role} size={18} />}
        <span>Asked by the {agent}</span>
      </p>
      {historyMinute !== null && (
        <p className="mt-1 text-micro text-fg-subtle" data-popup-history>
          Live decision — you’re viewing m{Math.round(historyMinute)}
        </p>
      )}
      <p id={`${id}-summary`} className="mt-1 text-body-lg text-fg">
        <GlossaryText text={approval.summary} />
      </p>

      <dl className="mt-2 grid gap-1 rounded-md bg-surface-sunken p-2 text-caption">
        <dt className="text-micro text-fg-subtle">Approving authorises</dt>
        <dd className="text-fg" data-popup-authorises>
          {scope?.authorises ?? `${toolLabel(approval.tool, true)}, as proposed`}
        </dd>
        <dt className="mt-1 text-micro text-fg-subtle">It does not authorise</dt>
        <dd className="text-fg-muted">
          {scope?.doesNotAuthorise.length ? (
            <ul className="list-disc pl-4">
              {scope.doesNotAuthorise.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          ) : (
            'Anything beyond this one action'
          )}
        </dd>
      </dl>

      {certifying && (
        <p className="mt-2 flex items-start gap-1 rounded-md bg-warning-bg px-2 py-1 text-caption text-fg">
          <Icon name="shield" size={12} className="mt-0.5 shrink-0 text-warning" />
          Reserved for certifying staff, so this one never approves itself, even in the simulation. A person
          must decide it.
        </p>
      )}

      {hasOptions && mode === 'idle' && (
        <fieldset className="mt-2">
          <legend className="text-micro text-fg-subtle">Choose an option</legend>
          <div className="mt-1 flex flex-col gap-1">
            {approval.options!.map((o) => (
              <label key={o.id} className="flex items-center gap-2 text-caption text-fg">
                <input
                  type="radio"
                  name={`${id}-option`}
                  value={o.id}
                  checked={optionId === o.id}
                  onChange={() => setOptionId(o.id)}
                />
                <span className="min-w-0 flex-1 truncate">{o.label}</span>
                {o.recommended && <Badge tone="neutral">recommended</Badge>}
              </label>
            ))}
          </div>
        </fieldset>
      )}

      {sending ? (
        <p role="status" className="mt-3 inline-flex items-center gap-2 text-caption text-fg-muted">
          <span className="h-2 w-2 animate-soft-pulse rounded-full bg-fg-muted" aria-hidden />
          Sending…
        </p>
      ) : mode === 'editing' ? (
        <div className="mt-3">
          <DiffEditor
            original={approval.args}
            onCancel={() => setMode('idle')}
            onSubmit={(editedArgs) => void send({ decision: 'edit', editedArgs, roleTitle })}
          />
        </div>
      ) : mode === 'rejecting' ? (
        <form
          className="mt-3 flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (reason.trim()) void send({ decision: 'reject', reason: reason.trim(), roleTitle });
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
          <Button variant="approve" size="sm" onClick={approve} aria-keyshortcuts="A">
            Approve <Kbd className="border-on-good/40 text-on-good">A</Kbd>
          </Button>
          {!hasOptions && (
            <Button size="sm" onClick={startEdit} aria-keyshortcuts="E">
              Edit <Kbd>E</Kbd>
            </Button>
          )}
          <Button variant="danger" size="sm" onClick={startReject} aria-keyshortcuts="R">
            Reject <Kbd className="border-critical/50 text-critical">R</Kbd>
          </Button>
          {failed && (
            <Badge tone="critical" icon="alert">
              Not sent — try again
            </Badge>
          )}
        </div>
      )}

      <div
        className="mt-3 flex items-center gap-2 border-t border-border pt-2 text-caption"
        data-popup-countdown
      >
        {countdownOn ? (
          <>
            <CountdownRing fraction={remaining / durationMs} size={18} />
            <span role="timer" className="num text-fg" data-paused={paused || undefined}>
              {paused ? `Paused while you look · ${seconds}s left` : `Approving automatically in ${seconds}s`}
            </span>
          </>
        ) : (
          <span className="flex min-w-0 flex-col gap-0.5 text-fg-muted" data-countdown-off>
            <span>{autoApprove && !engaged && !certifying ? 'Sending…' : 'Waiting for your decision'}</span>
            {!autoApprove && (
              <span className="text-micro text-fg-subtle" data-popup-pause-hint>
                Press <Kbd>Space</Kbd> to pause the clock while you decide
              </span>
            )}
          </span>
        )}
        <InfoTip on={autoApprove} />
      </div>
    </article>
  );
});

/** The countdown ring: depletes as the time runs out (stepwise; no animation needed for reduced motion). */
function CountdownRing({ fraction, size }: { fraction: number; size: number }) {
  const r = size / 2 - 2;
  const c = 2 * Math.PI * r;
  const f = Math.max(0, Math.min(1, fraction));
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      aria-hidden
      className="shrink-0 -rotate-90"
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        strokeWidth={2.5}
        className="stroke-surface-hover"
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        strokeWidth={2.5}
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - f)}
        className="stroke-warning"
        data-countdown-ring={Math.round(f * 100)}
      />
    </svg>
  );
}

function InfoTip({ on }: { on: boolean }) {
  return (
    <Tooltip.Provider delayDuration={200}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <button
            type="button"
            aria-label={on ? 'Why decisions approve themselves' : 'About auto-approve'}
            className="ml-auto inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-fg-muted outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-focus"
            data-popup-info
          >
            <Icon name="info" size={14} />
          </button>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            side="top"
            align="end"
            sideOffset={6}
            collisionPadding={8}
            className="z-[80] max-w-xs rounded-md border border-border bg-surface-raised px-3 py-2 text-caption text-fg shadow-e2"
          >
            {on ? AUTO_APPROVE_EXPLAINER : AUTO_APPROVE_OFF_EXPLAINER}
            <Tooltip.Arrow className="fill-surface-raised" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
