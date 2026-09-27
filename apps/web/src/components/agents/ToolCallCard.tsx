/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * One agent step, collapsed to a single line by default (thought summary; tool, args, tier, latency, citations).
 * Expand for the full thought, the args and the raw result. A guardrail block renders as a calm warning.
 */
import type { Citation } from '@ica/schema/browser';
import { useId, useState } from 'react';
import { headline, resultData } from '../../agents/headline';
import { GlossaryText } from '../../glossary/Term';
import type { FeedItem, ToolFeedItem } from '../../lib/derive';
import { ROLE_LABEL, actorLabel } from '../../lib/format';
import { Icon } from '../ui/Icon';
import { AiDraftedBadge, Badge, TierBadge, cx } from '../ui/primitives';
import { ProvenancePanel } from '../decisions/Provenance';
import { AgentMark } from './AgentMark';
import { ArgsList, compactArgs } from './ArgValue';
import { BlockedActionCard, InvalidationNotice, ProvisionalReadingBlock } from './PolicyCards';

function Citations({ citations }: { citations: Citation[] }) {
  return (
    <ul className="flex flex-col gap-1">
      {citations.map((c) => (
        <li key={c.chunkId} className="rounded-md border border-border bg-surface-sunken p-2">
          <div className="flex items-center gap-2 text-caption">
            <Icon name="link" size={12} className="text-fg-subtle" />
            <a
              href={c.url}
              target="_blank"
              rel="noreferrer noopener"
              className="truncate text-fg underline decoration-border-control underline-offset-2"
            >
              {c.title}
            </a>
            <span className="ml-auto font-mono text-micro text-fg-subtle">{c.sourceId}</span>
          </div>
          <blockquote className="mt-1 border-l-2 border-border-control pl-2 text-caption text-fg-muted">
            “{c.quote}”
          </blockquote>
        </li>
      ))}
    </ul>
  );
}

function Json({ value }: { value: unknown }) {
  return (
    <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-surface-sunken p-2 font-mono text-micro text-fg-muted">
      {typeof value === 'string' ? value : JSON.stringify(value, null, 2)}
    </pre>
  );
}

export function ToolCallCard({ item, defaultOpen = false }: { item: ToolFeedItem; defaultOpen?: boolean }) {
  const id = useId();
  const [open, setOpen] = useState(defaultOpen);
  const blocked = item.blocked;
  const cites = item.result?.citations ?? [];
  const latency = item.result?.latencyMs;
  const failed = item.result && !item.result.ok && !blocked;
  // Task 08: the title line is generated in code from the tool, its arguments and its result (never model text).
  const title = headline(
    item.call.tool,
    item.call.args,
    item.result ? resultData(item.result.result, item.result.resultPreview) : undefined,
    { minute: item.minute, failed: !!failed },
  );

  return (
    <article
      data-feed={item.key}
      className={cx(
        'rounded-md border px-2 py-2',
        blocked ? 'border-warning/50 bg-warning-bg' : 'border-border bg-surface-raised',
      )}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={`${id}-detail`}
        onClick={() => setOpen(!open)}
        className="flex w-full items-start gap-2 text-left"
      >
        <AgentMark role={item.role} size={20} />
        <span className="min-w-0 flex-1">
          <span className="line-clamp-2 text-body text-fg" data-card-title>
            {title}
          </span>
          <span className="mt-0.5 flex min-w-0 items-center gap-1 text-caption text-fg-subtle">
            <span className="shrink-0 font-mono text-fg-muted">{item.call.tool}</span>
            <span className="truncate font-mono">{compactArgs(item.call.args)}</span>
          </span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1">
          <TierBadge tier={item.call.tier} />
          <span className="flex items-center gap-1 text-micro text-fg-subtle">
            {cites.length > 0 && (
              <span className="inline-flex items-center gap-0.5" title={`${cites.length} citation(s)`}>
                <Icon name="link" size={10} />
                {cites.length}
              </span>
            )}
            {latency !== undefined && (
              <span className="num">
                {latency < 1000 ? `${latency} ms` : `${(latency / 1000).toFixed(1)} s`}
              </span>
            )}
            {failed && <span className="text-critical">failed</span>}
          </span>
        </span>
      </button>

      {blocked && blocked.layer === 'tier' && <BlockedActionCard block={blocked} className="mt-2" />}
      {blocked && blocked.layer !== 'tier' && (
        <p className="mt-2 flex gap-2 text-caption text-fg">
          <Icon name="shield" size={14} className="mt-0.5 shrink-0 text-warning" />
          <span>
            {blocked.reason} <span className="text-fg-muted">(guardrail layer: {blocked.layer})</span>
          </span>
        </p>
      )}
      {(item.call.normalisedFrom || item.call.argsRepaired?.length) && (
        <p className="mt-1 flex items-center gap-1 text-micro text-fg-subtle">
          <Icon name="edit" size={10} />
          {item.call.normalisedFrom
            ? `Called as “${item.call.normalisedFrom}”; run as a delegation by the runtime.`
            : `Arguments repaired by the runtime: ${item.call.argsRepaired!.join(', ')}.`}
        </p>
      )}
      {item.result?.deduplicatedFrom && (
        <p className="mt-1 flex items-center gap-1 text-micro text-fg-subtle">
          <Icon name="check" size={10} /> Retry of an earlier request: original result returned, nothing done
          twice.
        </p>
      )}
      {item.proposal?.supersedesApprovalId && (
        <p className="mt-2">
          <Badge tone="warning" icon="edit">
            Revised proposal (replaces an invalidated approval)
          </Badge>
        </p>
      )}

      {item.proposal && (
        <p className="mt-2 flex flex-wrap items-center gap-2 text-caption text-fg-muted">
          <Icon name="user" size={12} />
          {item.decision ? (
            <>
              <span>
                {item.decision.decision === 'reject'
                  ? 'Rejected'
                  : item.decision.decision === 'edit'
                    ? 'Edited and approved'
                    : 'Approved'}{' '}
                by <span className="text-fg">{actorLabel(item.decision.decidedBy)}</span>
              </span>
            </>
          ) : (
            <Badge tone="warning">Awaiting a human decision</Badge>
          )}
        </p>
      )}

      {open && (
        <div id={`${id}-detail`} className="mt-2 flex flex-col gap-2 border-t border-border pt-2">
          {item.thought && (
            <section>
              <h4 className="caps mb-1 flex items-center gap-2 text-fg-subtle">
                Thought <AiDraftedBadge />
              </h4>
              <p className="text-caption text-fg-muted">
                <GlossaryText text={item.thought.text} />
              </p>
            </section>
          )}
          <section>
            <h4 className="caps mb-1 text-fg-subtle">Arguments</h4>
            <ArgsList args={item.call.args} />
            <details className="mt-1">
              <summary className="cursor-pointer text-micro text-fg-subtle">Raw JSON</summary>
              <Json value={item.call.args} />
            </details>
          </section>
          {item.result && (
            <section>
              <h4 className="caps mb-1 text-fg-subtle">Result {item.result.ok ? '' : '(error)'}</h4>
              <Json value={item.result.result ?? item.result.resultPreview} />
            </section>
          )}
          {cites.length > 0 && (
            <section>
              <h4 className="caps mb-1 text-fg-subtle">Sources</h4>
              <Citations citations={cites} />
            </section>
          )}
          {item.proposal && (
            <ProvenancePanel
              createdAtMinute={item.minute}
              dataAsOfMinute={item.proposal.dataAsOfMinute}
              citations={item.proposal.citations}
              unresolvedChecks={item.proposal.unresolvedChecks}
              approvalScope={item.proposal.approvalScope}
            />
          )}
        </div>
      )}
    </article>
  );
}

/** Non-tool feed items: agent started, standalone thought, report, abort, unattached block. */
export function FeedLine({ item }: { item: Exclude<FeedItem, ToolFeedItem> }) {
  const [open, setOpen] = useState(false);
  if (item.kind === 'started') {
    return (
      <p className="flex items-center gap-2 px-1 text-caption text-fg-subtle">
        <AgentMark role={item.role} size={16} />
        <span className="truncate">
          {item.role === 'world' ? 'World' : ROLE_LABEL[item.role]} agent started —{' '}
          <GlossaryText text={item.brief} />
        </span>
      </p>
    );
  }
  if (item.kind === 'thought') {
    return (
      <article className="rounded-md border border-border bg-surface-raised px-2 py-2">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="flex w-full items-start gap-2 text-left"
        >
          <AgentMark role={item.role} size={20} />
          <span className="line-clamp-2 min-w-0 flex-1 text-body text-fg-muted">
            <GlossaryText text={item.summary} focusable={false} />
          </span>
        </button>
        {open && (
          <p className="mt-2 border-t border-border pt-2 text-caption text-fg-muted">
            <GlossaryText text={item.text} />
          </p>
        )}
      </article>
    );
  }
  if (item.kind === 'report') {
    return (
      <article className="rounded-md border border-border bg-surface-raised px-2 py-2">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="flex w-full items-start gap-2 text-left"
        >
          <AgentMark role={item.role} size={20} state="done" />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2 text-caption text-fg-muted">
              <Icon name="check" size={12} className="text-good" /> Report
              {item.report.composedByRuntime ? (
                <Badge tone="warning">Composed by the runtime</Badge>
              ) : (
                <AiDraftedBadge />
              )}
            </span>
            <span className="line-clamp-2 text-body text-fg">
              <GlossaryText text={item.report.summary} focusable={false} />
            </span>
          </span>
        </button>
        {item.report.screeningFlags && item.report.screeningFlags.length > 0 && (
          <p data-screening-flag className="mt-2 flex gap-2 text-caption text-fg">
            <Icon name="shield" size={14} className="mt-0.5 shrink-0 text-warning" />
            <span>
              Flagged by output screening (not blocked): the report states a status (
              {[...new Set(item.report.screeningFlags.map((f) => f.pattern.replace(/^status:/, '')))].join(
                ', ',
              )}
              ). A model reading is provisional; certifying staff decide.
            </span>
          </p>
        )}
        {item.report.provisionalReading && (
          <div className="mt-2">
            <ProvisionalReadingBlock reading={item.report.provisionalReading} />
          </div>
        )}
        {open && (
          <div className="mt-2 grid gap-2 border-t border-border pt-2 text-caption text-fg-muted">
            {(['actionsTaken', 'openIssues', 'recommendations'] as const).map((k) =>
              item.report[k].length ? (
                <section key={k}>
                  <h4 className="caps text-fg-subtle">
                    {k === 'actionsTaken'
                      ? 'Actions taken'
                      : k === 'openIssues'
                        ? 'Open issues'
                        : 'Recommendations'}
                  </h4>
                  <ul className="list-disc pl-4">
                    {item.report[k].map((x) => (
                      <li key={x}>
                        <GlossaryText text={x} />
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null,
            )}
            {item.report.citations.length > 0 && <Citations citations={item.report.citations} />}
            {item.report.extras && Object.keys(item.report.extras).length > 0 && (
              <section>
                <h4 className="caps text-fg-subtle">Additional fields</h4>
                <Json value={item.report.extras} />
              </section>
            )}
            {(item.report.recommendationDetails ?? []).map((d) => (
              <section key={d.text} aria-label={`Recommendation: ${d.text}`}>
                <h4 className="caps text-fg-subtle">Recommendation</h4>
                <p className="mb-1 text-fg">
                  <GlossaryText text={d.text} />
                </p>
                <ProvenancePanel
                  createdAtMinute={item.minute}
                  dataAsOfMinute={d.dataAsOfMinute}
                  citations={d.citations?.length ? d.citations : item.report.citations}
                  unresolvedChecks={d.unresolvedChecks}
                  approvalScope={d.approvalScope}
                />
              </section>
            ))}
          </div>
        )}
      </article>
    );
  }
  if (item.kind === 'invalidated') {
    return <InvalidationNotice invalidation={item.invalidation} proposal={item.proposal} />;
  }
  if (item.kind === 'aborted') {
    return (
      <p className="flex items-center gap-2 rounded-md bg-critical-bg px-2 py-1 text-caption text-fg">
        <Icon name="alert" size={12} className="text-critical" /> Agent stopped: {item.reason}
      </p>
    );
  }
  if (item.block.layer === 'tier') return <BlockedActionCard block={item.block} />;
  return (
    <article className="rounded-md border border-warning/50 bg-warning-bg px-2 py-2 text-caption text-fg">
      <span className="flex items-center gap-2">
        <Icon name="shield" size={14} className="text-warning" /> Guardrail ({item.block.layer})
      </span>
      <p className="mt-1">{item.block.reason}</p>
    </article>
  );
}
