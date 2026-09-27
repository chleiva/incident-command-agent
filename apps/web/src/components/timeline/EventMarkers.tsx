/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** Markers on the timeline track: trigger, decisions, messages, twists, blocks and baseline milestones. */
import type { Marker, MarkerKind } from '../../lib/derive';
import { cx } from '../ui/primitives';

const SHAPE: Record<MarkerKind, string> = {
  trigger: 'h-3 w-0.5 bg-fg',
  proposal: 'h-2 w-2 rotate-45 border border-fg-muted bg-surface',
  decision: 'h-2 w-2 rotate-45 bg-fg',
  message: 'h-2 w-2 rounded-full bg-fg-muted',
  twist: 'h-2 w-2 rounded-sm border border-fg bg-surface',
  blocked: 'h-2 w-2 rounded-full bg-warning',
  end: 'h-3 w-0.5 bg-fg-muted',
  baseline: 'h-2 w-2 rounded-full border border-fg-subtle',
  recovery: 'h-2 w-2 rotate-45 border border-warning bg-surface',
  failed: 'h-3 w-0.5 bg-critical',
};

export const MARKER_LEGEND: [MarkerKind, string][] = [
  ['trigger', 'Trigger'],
  ['decision', 'Decision'],
  ['message', 'Message'],
  ['twist', 'Twist'],
  ['blocked', 'Blocked'],
  ['baseline', 'Baseline'],
];

export function MarkerGlyph({ kind }: { kind: MarkerKind }) {
  return <span className={cx('inline-block shrink-0', SHAPE[kind])} aria-hidden />;
}

export function EventMarkers({
  markers,
  maxMinute,
  onJump,
  lane = 'agent',
}: {
  markers: Marker[];
  maxMinute: number;
  onJump: (m: Marker) => void;
  lane?: 'agent' | 'baseline';
}) {
  return (
    <div className="pointer-events-none absolute inset-0" aria-hidden>
      {markers
        .filter((m) => m.kind !== 'proposal' || lane === 'agent')
        .map((m) => (
          <button
            key={`${lane}-${m.seq}`}
            type="button"
            tabIndex={-1}
            title={`m${m.minute.toFixed(1)} · ${m.label}`}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => onJump(m)}
            className="pointer-events-auto absolute top-1/2 flex h-4 w-4 -translate-x-1/2 -translate-y-1/2 items-center justify-center"
            style={{ left: `${Math.min(100, (m.minute / Math.max(1, maxMinute)) * 100)}%` }}
          >
            <MarkerGlyph kind={m.kind} />
          </button>
        ))}
    </div>
  );
}
