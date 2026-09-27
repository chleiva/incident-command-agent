/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * The Agents view's slim timeline bar (task 08): sim clock, scrubber, play/pause, "Back to live" and the
 * "Hide thoughts" toggle (the view's only filter). It drives the same scrubber as the dashboard.
 */
import { useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { Icon } from '../ui/Icon';
import { cx } from '../ui/primitives';

export function AgentsTimelineBar({
  maxMinute,
  cursorMinute,
  live,
  clock,
  playing,
  onPlayToggle,
  onScrub,
  onLive,
  hideThoughts,
  onHideThoughts,
}: {
  maxMinute: number;
  cursorMinute: number;
  live: boolean;
  clock: (minute: number) => string;
  playing: boolean;
  onPlayToggle: () => void;
  onScrub: (minute: number) => void;
  onLive: () => void;
  hideThoughts: boolean;
  onHideThoughts: (on: boolean) => void;
}) {
  const track = useRef<HTMLDivElement>(null);
  const max = Math.max(1, maxMinute);
  const pct = Math.min(100, (Math.min(cursorMinute, max) / max) * 100);
  const minuteAt = (x: number) => {
    const r = track.current!.getBoundingClientRect();
    return Math.max(0, Math.min(max, ((x - r.left) / r.width) * max));
  };
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (!track.current) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    onScrub(minuteAt(e.clientX));
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (e.buttons !== 1 || !track.current) return;
    onScrub(minuteAt(e.clientX));
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 5 : 1;
    const next: Record<string, number | 'live'> = {
      ArrowLeft: cursorMinute - step,
      ArrowDown: cursorMinute - step,
      ArrowRight: cursorMinute + step,
      ArrowUp: cursorMinute + step,
      Home: 0,
      End: 'live',
    };
    const n = next[e.key];
    if (n === undefined) return;
    e.preventDefault();
    if (n === 'live' || n >= max) onLive();
    else onScrub(Math.max(0, n));
  };

  return (
    <div
      className="flex h-10 shrink-0 items-center gap-3 rounded-md border border-border bg-surface px-3"
      data-testid="agents-timeline"
    >
      <button
        type="button"
        onClick={onPlayToggle}
        aria-label={
          live
            ? playing
              ? 'Pause the world clock'
              : 'Resume the world clock'
            : playing
              ? 'Pause playback'
              : 'Play from here'
        }
        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-surface-hover text-fg hover:bg-surface-raised"
      >
        <Icon name={playing ? 'pause' : 'play'} size={14} />
      </button>
      <span className="num shrink-0 text-body text-fg" aria-label="Scenario time (UTC)">
        {clock(cursorMinute)}Z
      </span>
      <div
        ref={track}
        role="slider"
        tabIndex={0}
        aria-label="Timeline"
        aria-valuemin={0}
        aria-valuemax={Math.round(max)}
        aria-valuenow={Math.round(cursorMinute)}
        aria-valuetext={`${clock(cursorMinute)} UTC, minute ${cursorMinute.toFixed(0)}${live ? ', live' : ''}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onKeyDown={onKeyDown}
        data-testid="agents-scrubber"
        className="relative h-6 min-w-24 flex-1 cursor-pointer touch-none select-none rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        <div className="absolute inset-x-0 top-1/2 h-[6px] -translate-y-1/2 rounded-full bg-surface-hover" />
        <div
          className="absolute left-0 top-1/2 h-[6px] -translate-y-1/2 rounded-full bg-fg-muted"
          style={{ width: `${pct}%` }}
        />
        <div
          className="absolute top-1/2 h-4 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-fg"
          style={{ left: `${pct}%` }}
          aria-hidden
        />
      </div>
      {live ? (
        <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-fg px-2 py-0.5 text-caption font-medium text-bg">
          <span className="h-2 w-2 animate-soft-pulse rounded-full bg-bg" aria-hidden /> Live
        </span>
      ) : (
        <button
          type="button"
          onClick={onLive}
          data-testid="back-to-live"
          className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-warning-bg px-2 py-0.5 text-caption font-medium text-warning hover:brightness-110"
        >
          Viewing m{Math.round(cursorMinute)} — Back to live
        </button>
      )}
      <button
        type="button"
        role="switch"
        aria-checked={hideThoughts}
        onClick={() => onHideThoughts(!hideThoughts)}
        className="inline-flex shrink-0 items-center gap-2 text-caption text-fg-muted hover:text-fg"
      >
        <span
          aria-hidden
          className={cx(
            'relative inline-flex h-4 w-7 items-center rounded-full transition-colors',
            hideThoughts ? 'bg-fg' : 'bg-surface-hover',
          )}
        >
          <span
            className={cx(
              'absolute h-3 w-3 rounded-full transition-transform',
              hideThoughts ? 'translate-x-[14px] bg-bg' : 'translate-x-0.5 bg-fg-muted',
            )}
          />
        </span>
        Hide thoughts
      </button>
    </div>
  );
}
