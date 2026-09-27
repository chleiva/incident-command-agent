/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** One KPI: value, ghost delta vs baseline (small grey figure), 60-minute sparkline. Click → why this number. */
import type { KpiSnapshot } from '@ica/schema/browser';
import type { KpiPoint } from '../../lib/derive';
import { AnimatedNumber } from '../ui/AnimatedNumber';
import { Icon } from '../ui/Icon';
import { cx, type Tone } from '../ui/primitives';
import { GlossaryText } from '../../glossary/Term';
import type { CheckItem, TileModel } from './kpiModel';
import { Sparkline } from './Sparkline';

const TONE_TEXT: Record<Tone, string> = {
  neutral: 'text-fg',
  good: 'text-good',
  warning: 'text-warning',
  critical: 'text-critical',
  ai: 'text-ai',
};
const TONE_BAR: Record<Tone, string> = {
  neutral: 'bg-transparent',
  good: 'bg-good',
  warning: 'bg-warning',
  critical: 'bg-critical',
  ai: 'bg-ai',
};

export function KpiTile({
  model,
  series,
  onOpen,
  dense = false,
}: {
  model: TileModel;
  /** The snapshot the model was built from (kept for callers; the model carries everything rendered). */
  kpis: KpiSnapshot;
  series: KpiPoint[];
  onOpen?: (key: TileModel['key']) => void;
  dense?: boolean;
}) {
  const points = series.map((p) => ({ minute: p.minute, value: model.series(p.kpis) }));
  const toneLabel =
    model.tone === 'neutral'
      ? ''
      : model.tone === 'warning'
        ? ' (threshold crossed)'
        : ' (critical threshold crossed)';
  return (
    <button
      type="button"
      onClick={() => onOpen?.(model.key)}
      aria-label={`${model.label}: ${model.display}${toneLabel}. ${model.ghost ?? ''} Open why this number.`}
      data-kpi={model.key}
      className={cx(
        'group relative flex min-w-0 flex-col gap-1 overflow-hidden rounded-lg border border-border bg-surface px-3 py-2 text-left shadow-e1 transition-colors duration-fast hover:bg-surface-raised',
      )}
    >
      <span className={cx('absolute inset-y-0 left-0 w-0.5', TONE_BAR[model.tone])} aria-hidden />
      <span className="flex items-center gap-1">
        <span className="caps truncate text-fg-muted">
          <GlossaryText text={model.label} focusable={false} />
        </span>
        <Icon
          name="info"
          size={12}
          className="ml-auto shrink-0 text-fg-subtle opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
        />
      </span>
      {model.checks ? (
        <CheckList items={model.checks} testId={`kpi-value-${model.key}`} dense={dense} />
      ) : (
        <span className="flex min-w-0 items-center gap-2">
          <span
            data-testid={`kpi-value-${model.key}`}
            className={cx(
              'num truncate font-semibold',
              dense ? 'text-title' : 'text-figure',
              TONE_TEXT[model.tone],
            )}
          >
            {model.key === 'cost' ? (
              <AnimatedNumber value={model.value} format={model.format} />
            ) : (
              model.display
            )}
          </span>
          {!dense && (
            <span
              className={cx(
                'ml-auto shrink-0',
                model.tone === 'neutral' ? 'text-fg-subtle' : TONE_TEXT[model.tone],
              )}
            >
              <Sparkline points={points} />
            </span>
          )}
        </span>
      )}
      {model.key === 'satisfaction' && !dense && (
        <span className="h-1 w-full overflow-hidden rounded-full bg-surface-hover" aria-hidden>
          <span
            className={cx(
              'block h-full rounded-full transition-[width] duration-slow',
              model.tone === 'neutral' ? 'bg-fg-subtle' : TONE_BAR[model.tone],
            )}
            style={{ width: `${Math.max(0, Math.min(100, model.value))}%` }}
          />
        </span>
      )}
      <span className="num truncate text-micro text-fg-subtle">
        <GlossaryText text={model.ghost ?? model.sub} focusable={false} />
      </span>
    </button>
  );
}

const GLYPH: Record<CheckItem['status'], { glyph: string; className: string; sr: string }> = {
  pass: { glyph: '✓', className: 'text-good', sr: 'met' },
  fail: { glyph: '✗', className: 'text-critical', sr: 'not met' },
  pending: { glyph: '…', className: 'text-fg-subtle', sr: 'pending' },
};

/** Compliance and safety as check status (✓ / ✗ / pending), never a numeric score. */
function CheckList({ items, testId, dense }: { items: CheckItem[]; testId: string; dense: boolean }) {
  return (
    <ul data-testid={testId} className={cx('flex min-w-0 flex-col', dense ? 'gap-0' : 'gap-0.5')}>
      {items.map((i) => (
        <li
          key={i.key}
          data-check={i.key}
          data-status={i.status}
          className="flex min-w-0 items-start gap-1 text-micro leading-tight"
          title={i.note ? `${i.label}: ${i.note}` : i.label}
        >
          <span
            aria-hidden
            className={cx('w-3 shrink-0 text-center font-semibold', GLYPH[i.status].className)}
          >
            {GLYPH[i.status].glyph}
          </span>
          <span className="sr-only">{GLYPH[i.status].sr}: </span>
          <span className={cx('min-w-0 truncate', i.status === 'fail' ? 'text-fg' : 'text-fg-muted')}>
            <GlossaryText text={i.label} focusable={false} />
          </span>
        </li>
      ))}
    </ul>
  );
}
