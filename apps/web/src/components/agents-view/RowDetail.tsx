/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * The expanded row (task 08): 1. Facts gathered by this turn (reconstructed from the run's events, not the exact
 * model context), 2. What it decided (plain words, plus the turn's AI reasoning, labelled unverified), 3. Detail by
 * row type (arguments and result; proposal payload, scope and the human decision; the guardrail's reason, rule and
 * authority; the structured report).
 */
import * as Tooltip from '@radix-ui/react-tooltip';
import { PROVISIONAL_READING_LABEL, type Actor, type Citation } from '@ica/schema/browser';
import type { ReactNode } from 'react';
import type { AgentRow, Fact } from '../../agents/rows';
import { roleName } from '../../agents/roles';
import { GlossaryText } from '../../glossary/Term';
import { SIMULATION_AUTO_LABEL, actorLabel, isSimulationAuto } from '../../lib/format';
import { ArgsList, ArgValue, CitationChips, LongText } from '../agents/ArgValue';
import { AUTHORITY_FALLBACK } from '../agents/PolicyCards';
import { Icon } from '../ui/Icon';
import { AiDraftedBadge, Badge, cx } from '../ui/primitives';

export const FACTS_HEADING = 'Facts gathered by this turn';
export const FACTS_TOOLTIP = "Reconstructed from the run's events; the model's full context is in the trace.";
export const REASONING_LABEL = 'AI reasoning (unverified)';

function Section({ title, children, extra }: { title: string; children: ReactNode; extra?: ReactNode }) {
  return (
    <section className="flex flex-col gap-1">
      <h4 className="caps flex items-center gap-1 text-fg-subtle">
        {title}
        {extra}
      </h4>
      {children}
    </section>
  );
}

function InfoTip({ text }: { text: string }) {
  return (
    <Tooltip.Provider delayDuration={200}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <button
            type="button"
            aria-label={text}
            className="inline-flex h-4 w-4 items-center justify-center rounded-sm text-fg-subtle hover:text-fg"
          >
            <Icon name="info" size={12} />
          </button>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            side="top"
            sideOffset={4}
            collisionPadding={8}
            className="z-[80] max-w-xs rounded-md border border-border bg-surface-raised px-2 py-1 text-caption normal-case tracking-normal text-fg shadow-e2"
          >
            {text}
            <Tooltip.Arrow className="fill-surface-raised" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}

function FactCards({ facts }: { facts: Fact[] }) {
  if (!facts.length)
    return <p className="text-caption text-fg-subtle">Nothing gathered yet at this point.</p>;
  return (
    <ul className="flex flex-col gap-1" aria-label={FACTS_HEADING}>
      {facts.map((f) => (
        <li
          key={f.key}
          data-fact={f.kind}
          className={cx(
            'rounded-sm border px-2 py-1 text-caption',
            f.failed ? 'border-critical/40 bg-critical-bg' : 'border-border bg-surface-sunken',
          )}
        >
          <span className="flex items-center gap-1 text-fg">
            <Icon
              name={
                f.kind === 'brief'
                  ? 'arrowLeft'
                  : f.kind === 'report'
                    ? 'check'
                    : f.kind === 'decision'
                      ? 'decision'
                      : 'wrench'
              }
              size={11}
              className="shrink-0 text-fg-subtle"
            />
            <span className="min-w-0">{f.title}</span>
          </span>
          {f.detail && (
            <span className="mt-0.5 block break-words text-micro text-fg-muted">
              <LongText text={f.detail} max={140} />
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

function decidedByLine(a: Actor): string {
  if (a.kind === 'policy')
    return a.policy === 'baseline' ? 'Baseline policy (not a person)' : 'Eval auto-approver (not a person)';
  return actorLabel(a);
}

function Citations({ citations }: { citations: Citation[] }) {
  if (!citations.length) return null;
  return <CitationChips citations={citations} />;
}

function Bullets({ items }: { items: string[] }) {
  return (
    <ul className="list-disc pl-4 text-caption text-fg-muted">
      {items.map((x, i) => (
        <li key={i}>
          <GlossaryText text={x} />
        </li>
      ))}
    </ul>
  );
}

function DetailBody({ row }: { row: AgentRow }) {
  const parts: ReactNode[] = [];
  if (row.kind === 'brief' && row.brief) {
    parts.push(
      <div key="brief" className="text-caption text-fg-muted">
        <span className="mb-1 flex items-center gap-1 text-micro text-fg-subtle">
          Brief {row.link ? `from ${roleName(row.link.role)}` : ''} <AiDraftedBadge />
        </span>
        <GlossaryText text={row.brief} />
      </div>,
    );
  }
  if (row.call && row.kind !== 'waiting') {
    parts.push(
      <div key="args">
        <span className="text-micro text-fg-subtle">Arguments</span>
        <ArgsList args={row.call.args} />
      </div>,
    );
    if (row.result)
      parts.push(
        <div key="result">
          <span className="text-micro text-fg-subtle">Result{row.result.ok ? '' : ' (error)'}</span>
          <div className="text-caption text-fg-muted">
            {row.result.result && typeof row.result.result === 'object' ? (
              <ArgValue value={row.result.result} />
            ) : (
              <LongText text={row.result.resultPreview} />
            )}
          </div>
          {row.result.citations && <Citations citations={row.result.citations} />}
        </div>,
      );
    if (row.call.argsRepaired?.length || row.call.normalisedFrom || row.call.argsTruncated?.length)
      parts.push(
        <p key="repair" className="flex items-center gap-1 text-micro text-fg-subtle">
          <Icon name="edit" size={10} /> The runtime tidied this call&apos;s arguments before running it.
        </p>,
      );
    if (row.reused)
      parts.push(
        <p key="reused" className="flex items-center gap-1 text-micro text-fg-subtle" data-reused-detail>
          <Icon name="check" size={10} /> Called again {row.reused === 1 ? 'once' : `${row.reused} times`}{' '}
          with the same details: the same result was reused, nothing was done twice.
        </p>,
      );
  }
  if (row.proposal && (row.kind === 'proposal' || row.kind === 'waiting')) {
    const p = row.proposal;
    parts.push(
      <div key="proposal" className="flex flex-col gap-1 text-caption">
        {row.kind === 'waiting' && (
          <>
            <span className="text-micro text-fg-subtle">Proposed action</span>
            <ArgsList args={p.args} />
          </>
        )}
        {p.approvalScope && (
          <div data-approval-scope>
            <span className="text-micro text-fg-subtle">Approval scope</span>
            <p className="text-fg-muted">Authorises: {p.approvalScope.authorises}</p>
            {p.approvalScope.doesNotAuthorise.length > 0 && (
              <p className="text-fg-muted">
                Does not authorise: {p.approvalScope.doesNotAuthorise.join('; ')}
              </p>
            )}
          </div>
        )}
        {p.unresolvedChecks && p.unresolvedChecks.length > 0 && (
          <div>
            <span className="text-micro text-fg-subtle">Not yet checked</span>
            <Bullets items={p.unresolvedChecks} />
          </div>
        )}
        {p.citations && <Citations citations={p.citations} />}
      </div>,
    );
  }
  if (row.decision) {
    const d = row.decision;
    parts.push(
      <div key="decision" className="text-caption text-fg-muted" data-decision-detail>
        <span className="text-micro text-fg-subtle">
          {d.decidedBy.kind === 'human' ? 'Human decision' : 'Decision (not a person)'}
        </span>
        {isSimulationAuto(d.decidedBy) ? (
          <p>
            <span className="text-fg">{SIMULATION_AUTO_LABEL}</span> at m{Math.round(d.minute)} — nobody
            decided in time, so the simulation approved it (not a person)
          </p>
        ) : (
          <p>
            {d.decision === 'reject'
              ? 'Rejected'
              : d.decision === 'edit'
                ? 'Approved with edits'
                : 'Approved'}{' '}
            by <span className="text-fg">{decidedByLine(d.decidedBy)}</span> at m{Math.round(d.minute)}
          </p>
        )}
        {d.reason && <p>Reason: {d.reason}</p>}
        {d.editedArgs && (
          <>
            <span className="text-micro text-fg-subtle">Edited details</span>
            <ArgsList args={d.editedArgs} />
          </>
        )}
      </div>,
    );
  } else if (row.kind === 'proposal' || row.kind === 'waiting') {
    parts.push(
      <p key="pending" className="text-caption text-warning">
        No decision yet.
      </p>,
    );
  }
  if (row.block) {
    const b = row.block;
    const fallback = b.tool ? AUTHORITY_FALLBACK[b.tool] : undefined;
    const rule = b.rule ?? fallback?.rule;
    const authority = b.authority ?? fallback?.authority;
    parts.push(
      <dl
        key="block"
        data-block-detail
        className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 rounded-sm border border-warning/50 bg-warning-bg p-2 text-caption"
      >
        <dt className="text-fg-subtle">Why</dt>
        <dd className="text-fg">
          <GlossaryText text={b.reason} />
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
            <dd className="text-fg-muted">{authority}</dd>
          </>
        )}
        {b.presenterTriggered && (
          <>
            <dt className="text-fg-subtle">Note</dt>
            <dd className="text-fg-muted">Presenter-triggered demonstration</dd>
          </>
        )}
      </dl>,
    );
  }
  if (row.invalidation) {
    parts.push(
      <ul key="inv" className="text-caption text-fg-muted" data-invalidation-detail>
        {row.invalidation.affectedAssumptions.map((a) => (
          <li key={a.key}>
            {a.key}: {String(a.was)} → <span className="text-fg">{String(a.now)}</span>
          </li>
        ))}
      </ul>,
    );
  }
  if (row.aborted) {
    parts.push(
      <p key="stop" className="text-caption text-fg-muted">
        {row.aborted.detail}
      </p>,
    );
  }
  if (row.report) {
    const r = row.report;
    parts.push(
      <div key="report" className="flex flex-col gap-2 text-caption text-fg-muted" data-report-detail>
        <div>
          <span className="flex items-center gap-1 text-micro text-fg-subtle">
            Summary{' '}
            {r.composedByRuntime ? <Badge tone="warning">Composed by the runtime</Badge> : <AiDraftedBadge />}
          </span>
          <GlossaryText text={r.summary} />
        </div>
        {r.actionsTaken?.length > 0 && (
          <div>
            <span className="text-micro text-fg-subtle">Actions taken</span>
            <Bullets items={r.actionsTaken} />
          </div>
        )}
        {r.openIssues?.length > 0 && (
          <div>
            <span className="text-micro text-fg-subtle">Open issues</span>
            <Bullets items={r.openIssues} />
          </div>
        )}
        {r.recommendations?.length > 0 && (
          <div>
            <span className="text-micro text-fg-subtle">Recommendations</span>
            <Bullets items={r.recommendations} />
          </div>
        )}
        {r.provisionalReading && (
          <div className="rounded-sm border border-border bg-surface-sunken p-2" data-provisional>
            <span className="text-micro text-fg-subtle">{PROVISIONAL_READING_LABEL}</span>
            <p>
              <GlossaryText text={r.provisionalReading.text} />
            </p>
          </div>
        )}
        <Citations citations={r.citations ?? []} />
      </div>,
    );
  }
  const flagged = [
    ...(row.flags ?? []).flatMap((f) => (f.findings?.length ? f.findings.map((x) => x.pattern) : [f.reason])),
    ...(row.report?.screeningFlags ?? []).map((f) => f.pattern),
  ].map((x) => x.replace(/^status:/, ''));
  if (flagged.length) {
    parts.push(
      <p key="flags" data-screening-flag className="flex gap-1 text-caption text-fg">
        <Icon name="shield" size={12} className="mt-0.5 shrink-0 text-warning" />
        <span>
          Flagged by output screening (not blocked): {[...new Set(flagged)].join(', ')}. A model reading is
          provisional; people decide.
        </span>
      </p>,
    );
  }
  if (!parts.length) return <p className="text-caption text-fg-subtle">No further detail.</p>;
  return <div className="flex flex-col gap-2">{parts}</div>;
}

export function RowDetail({
  id,
  row,
  facts,
  reasoning,
  decided,
}: {
  id: string;
  row: AgentRow;
  facts: Fact[];
  reasoning?: string;
  /** "What it decided", in plain words. */
  decided: string;
}) {
  return (
    <div
      id={id}
      role="region"
      aria-label={`Detail: ${row.headline}`}
      data-row-detail
      className="flex flex-col gap-3 border-t border-border px-2 pb-2 pt-2"
    >
      <Section title={FACTS_HEADING} extra={<InfoTip text={FACTS_TOOLTIP} />}>
        <FactCards facts={facts} />
      </Section>
      <Section title="What it decided">
        <p className="text-caption text-fg">{decided}</p>
        {reasoning && (
          <div className="rounded-sm border border-ai/30 bg-ai-bg/40 p-2" data-reasoning>
            <span className="mb-1 flex items-center gap-1 text-micro text-ai">
              <Icon name="sparkle" size={10} /> {REASONING_LABEL}
            </span>
            <p className="text-caption text-fg-muted">
              <GlossaryText text={reasoning} />
            </p>
          </div>
        )}
      </Section>
      <Section title="Detail">
        <DetailBody row={row} />
      </Section>
    </div>
  );
}
