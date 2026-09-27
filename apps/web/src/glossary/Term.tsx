/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * `<Term>` and `<GlossaryText>` (task 06 §1.11). A term is a Radix Tooltip trigger: keyboard-accessible (it opens on
 * focus), 300 ms hover delay, showing the one-line plain-English definition. In plain-language mode (⌘K → "Plain
 * language") the term renders its `inline` replacement instead; the tooltip still names the original term.
 * `<GlossaryText>` wraps the first occurrence of each glossary alias in a block of free text.
 */
import * as Tooltip from '@radix-ui/react-tooltip';
import { Fragment, type ReactNode } from 'react';
import { useUi } from '../store/ui';
import { cx } from '../components/ui/primitives';
import { lookup, segmentText } from './glossary';

export const TOOLTIP_DELAY_MS = 300;

export function Term({
  term,
  children,
  focusable = true,
  className,
}: {
  /** Glossary key or alias, e.g. "MEL", "OCC" or "certifying staff". */
  term: string;
  /** The original wording to show when plain language is off (default: `term`). */
  children?: ReactNode;
  /** False inside another interactive element (e.g. a card's button); hover still shows the definition. */
  focusable?: boolean;
  className?: string;
}) {
  const plain = useUi((s) => s.plainLanguage);
  const entry = lookup(term);
  const original = children ?? term;
  if (!entry) return <>{original}</>;
  return (
    <Tooltip.Provider delayDuration={TOOLTIP_DELAY_MS} skipDelayDuration={100}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <span
            tabIndex={focusable ? 0 : undefined}
            data-term={entry.term}
            data-plain={plain ? 'on' : 'off'}
            className={cx(
              'cursor-help underline decoration-fg-subtle decoration-dotted underline-offset-2 outline-none focus-visible:rounded-sm focus-visible:ring-1 focus-visible:ring-focus',
              className,
            )}
          >
            {plain ? entry.inline : original}
          </span>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            side="top"
            sideOffset={4}
            collisionPadding={8}
            className="z-[80] max-w-xs rounded-md border border-border bg-surface-raised px-2 py-1 text-caption text-fg shadow-e2"
          >
            <span className="font-semibold">{plain ? original : entry.term}</span>
            {': '}
            {entry.definition}
            <Tooltip.Arrow className="fill-surface-raised" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}

/** Free text (agent thoughts, tool results, messages) with the first occurrence of each glossary term wrapped. */
export function GlossaryText({ text, focusable = true }: { text: string; focusable?: boolean }) {
  return (
    <>
      {segmentText(text).map((seg, i) =>
        typeof seg === 'string' ? (
          <Fragment key={i}>{seg}</Fragment>
        ) : (
          <Term key={i} term={seg.entry.term} focusable={focusable}>
            {seg.text}
          </Term>
        ),
      )}
    </>
  );
}

/** Plain-language state and toggle (for the palette and tests). */
export function usePlainLanguage(): [boolean, () => void] {
  return [useUi((s) => s.plainLanguage), useUi((s) => s.togglePlainLanguage)];
}
