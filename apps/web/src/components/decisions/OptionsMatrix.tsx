/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Alternatives comparison: a ranked matrix (time to departure, cost, customer impact, compliance, constraints)
 * with bar-in-cell encoding; the recommended row is highlighted. Choosing a row is the decision.
 * Laid out as a two-line grid per option so it stays readable in the narrow decision rail.
 */
import type { DecisionOption } from '@ica/schema/browser';
import type { CSSProperties } from 'react';
import { formatDuration, formatEurCompact } from '../../lib/format';
import { Icon } from '../ui/Icon';
import { Badge, cx } from '../ui/primitives';
import { ProvenancePanel } from './Provenance';

/** Recommended first, then compliant, then fastest. */
export function rankOptions(options: readonly DecisionOption[]): DecisionOption[] {
  return [...options].sort(
    (a, b) =>
      Number(b.recommended) - Number(a.recommended) ||
      Number(b.metrics.compliant) - Number(a.metrics.compliant) ||
      a.metrics.timeToDepartureMin - b.metrics.timeToDepartureMin,
  );
}

const COLS = 'grid grid-cols-[minmax(0,1fr)_64px_64px_48px_24px] gap-x-2';
const at = (col: string, row: number): CSSProperties => ({ gridColumn: col, gridRow: row });

function Bar({ value, max, label, name }: { value: number; max: number; label: string; name: string }) {
  const pct = max > 0 ? Math.max(4, Math.round((value / max) * 100)) : 0;
  return (
    <span className="flex min-w-0 flex-col gap-1">
      <span className="num text-caption text-fg">
        <span className="sr-only">{name}: </span>
        {label}
      </span>
      <span className="h-1 w-full rounded-full bg-surface-hover" aria-hidden>
        <span className="block h-full rounded-full bg-fg-subtle" style={{ width: `${pct}%` }} />
      </span>
    </span>
  );
}

export function OptionsMatrix({
  options,
  selectedId,
  disabled = false,
  onSelect,
  createdAtMinute,
}: {
  options: readonly DecisionOption[];
  selectedId?: string;
  disabled?: boolean;
  onSelect: (optionId: string) => void;
  /** Sim minute the decision was requested (shown with each option's provenance). */
  createdAtMinute?: number;
}) {
  const ranked = rankOptions(options);
  const maxTime = Math.max(...options.map((o) => o.metrics.timeToDepartureMin));
  const maxCost = Math.max(...options.map((o) => o.metrics.costEur));
  return (
    <div role="table" aria-label="Alternatives, ranked" className="flex flex-col gap-1">
      <div role="row" className={cx(COLS, 'px-2 text-micro text-fg-subtle')}>
        <span role="columnheader" className="caps">
          Option
        </span>
        <span role="columnheader" className="caps" title="Time to departure">
          Departs
        </span>
        <span role="columnheader" className="caps">
          Cost
        </span>
        <span role="columnheader" className="caps" title="Customer impact, 0–100 (lower is better)">
          Impact
        </span>
        <span role="columnheader" className="caps" title="Compliant">
          OK
        </span>
      </div>
      {ranked.map((o, i) => {
        const selected = o.id === selectedId;
        return (
          <div
            key={o.id}
            role="row"
            data-option={o.id}
            className={cx(
              COLS,
              'gap-y-1 rounded-md px-2 py-2',
              o.recommended ? 'bg-ai-bg' : 'bg-surface-sunken',
              selected && 'ring-1 ring-good',
            )}
          >
            <span role="cell" style={at('1 / 4', 1)} className="flex min-w-0 flex-wrap items-center gap-1">
              <span className="num text-caption text-fg-subtle">{i + 1}.</span>
              <span className="text-body text-fg">{o.label}</span>
              {o.recommended && (
                <Badge tone="ai" icon="sparkle">
                  Recommended
                </Badge>
              )}
            </span>
            <span role="cell" style={at('2', 2)}>
              <Bar
                name="Time to departure"
                value={o.metrics.timeToDepartureMin}
                max={maxTime}
                label={formatDuration(o.metrics.timeToDepartureMin)}
              />
            </span>
            <span role="cell" style={at('3', 2)}>
              <Bar
                name="Cost"
                value={o.metrics.costEur}
                max={maxCost}
                label={formatEurCompact(o.metrics.costEur)}
              />
            </span>
            <span role="cell" style={at('4', 2)}>
              <Bar
                name="Customer impact"
                value={o.metrics.customerImpact}
                max={100}
                label={`${o.metrics.customerImpact}`}
              />
            </span>
            <span role="cell" style={at('5', 2)} className="pt-0.5">
              {o.metrics.compliant ? (
                <Icon name="check" size={13} label="Compliant" className="text-fg-muted" />
              ) : (
                <Icon name="alert" size={13} label="Not compliant" className="text-warning" />
              )}
            </span>
            <span role="cell" style={at('1', 2)} className="min-w-0">
              {o.metrics.constraints.length > 0 && (
                <ul className="flex flex-wrap gap-1" aria-label="Constraints">
                  {o.metrics.constraints.map((c) => (
                    <li key={c} className="rounded-sm bg-surface-hover px-1 text-micro text-fg-muted">
                      {c}
                    </li>
                  ))}
                </ul>
              )}
            </span>
            <span role="cell" style={at('4 / 6', 1)} className="flex justify-end">
              <button
                type="button"
                disabled={disabled}
                onClick={() => onSelect(o.id)}
                aria-label={`Choose: ${o.label}`}
                className={cx(
                  'h-6 rounded-md px-2 text-caption font-medium disabled:opacity-50',
                  o.recommended
                    ? 'bg-good text-on-good hover:brightness-110'
                    : 'border border-border-control/70 text-fg hover:bg-surface-hover',
                )}
              >
                {selected ? 'Chosen' : 'Choose'}
              </button>
            </span>
            <span role="cell" style={at('1 / 6', 3)} className="min-w-0">
              <details data-option-provenance={o.id}>
                <summary className="cursor-pointer text-micro text-fg-muted hover:text-fg">
                  Sources, checks and what choosing it authorises
                  {o.unresolvedChecks?.length ? ` · ${o.unresolvedChecks.length} not yet verified` : ''}
                </summary>
                <ProvenancePanel
                  className="mt-1"
                  createdAtMinute={createdAtMinute}
                  dataAsOfMinute={o.dataAsOfMinute}
                  citations={o.citations}
                  unresolvedChecks={o.unresolvedChecks}
                  approvalScope={o.approvalScope}
                />
              </details>
            </span>
          </div>
        );
      })}
    </div>
  );
}
