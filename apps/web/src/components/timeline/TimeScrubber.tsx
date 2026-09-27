/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * "What changed?" Time is a first-class axis: drag (or use the arrow keys) to time-travel — the whole screen is
 * rebuilt from the event log with the shared reducer. Play/pause, speed, and Live to rejoin the head.
 */
import { useRef, type KeyboardEvent, type PointerEvent } from 'react';
import type { Marker } from '../../lib/derive';
import { Icon } from '../ui/Icon';
import { StateFrame, cx, type LoadStatus } from '../ui/primitives';
import { EventMarkers, MARKER_LEGEND, MarkerGlyph } from './EventMarkers';

export const SPEEDS = [1, 6, 15, 30] as const;

export function TimeScrubber({
  maxMinute,
  cursorMinute,
  live,
  markers,
  baselineMarkers = [],
  onScrub,
  onJump,
  onLive,
  playing,
  onPlayToggle,
  speed,
  onSpeed,
  clock,
  status = 'ready',
  error,
}: {
  maxMinute: number;
  cursorMinute: number;
  live: boolean;
  markers: Marker[];
  baselineMarkers?: Marker[];
  onScrub: (minute: number) => void;
  onJump: (marker: Marker) => void;
  onLive: () => void;
  /** Live: the world clock is running. History: local playback is running. */
  playing: boolean;
  onPlayToggle: () => void;
  speed: number;
  onSpeed: (speed: number) => void;
  clock: (minute: number) => string;
  status?: LoadStatus;
  error?: string | null;
}) {
  const track = useRef<HTMLDivElement>(null);
  const max = Math.max(1, maxMinute);
  const pct = Math.min(100, (Math.min(cursorMinute, max) / max) * 100);

  const minuteAt = (clientX: number) => {
    const r = track.current!.getBoundingClientRect();
    return Math.max(0, Math.min(max, ((clientX - r.left) / r.width) * max));
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
    const map: Record<string, number | 'live'> = {
      ArrowLeft: cursorMinute - step,
      ArrowDown: cursorMinute - step,
      ArrowRight: cursorMinute + step,
      ArrowUp: cursorMinute + step,
      PageDown: cursorMinute - 10,
      PageUp: cursorMinute + 10,
      Home: 0,
      End: 'live',
    };
    const next = map[e.key];
    if (next === undefined) return;
    e.preventDefault();
    if (next === 'live' || next >= max) onLive();
    else onScrub(Math.max(0, next));
  };

  return (
    <StateFrame
      status={status}
      error={error}
      empty={maxMinute <= 0 && markers.length === 0}
      emptyText="The timeline starts with the first event."
    >
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onPlayToggle}
            aria-label={
              live
                ? playing
                  ? 'Pause the world clock (Space)'
                  : 'Resume the world clock (Space)'
                : playing
                  ? 'Pause playback'
                  : 'Play from here'
            }
            className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-surface-hover text-fg hover:bg-surface-raised"
          >
            <Icon name={playing ? 'pause' : 'play'} size={14} />
          </button>
          <button
            type="button"
            onClick={onLive}
            aria-pressed={live}
            className={cx(
              'inline-flex h-6 items-center gap-1 rounded-full px-2 text-caption font-medium',
              live ? 'bg-fg text-bg' : 'border border-border-control/70 text-fg-muted hover:text-fg',
            )}
          >
            <span
              className={cx('h-2 w-2 rounded-full', live ? 'animate-soft-pulse bg-bg' : 'bg-fg-subtle')}
              aria-hidden
            />
            Live
          </button>
          <div
            role="radiogroup"
            aria-label={live ? 'World speed' : 'Playback speed'}
            className="flex rounded-md bg-surface-sunken p-0.5"
          >
            {SPEEDS.map((s) => (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={speed === s}
                onClick={() => onSpeed(s)}
                className={cx(
                  'num h-6 rounded-sm px-2 text-micro',
                  speed === s ? 'bg-surface-hover text-fg' : 'text-fg-muted hover:text-fg',
                )}
              >
                {s}×
              </button>
            ))}
          </div>
          <span className="num ml-auto text-caption text-fg-muted">
            <span className="text-fg">{clock(cursorMinute)}Z</span> · m{cursorMinute.toFixed(1)}
            {!live && <span className="text-warning"> · history</span>}
          </span>
        </div>

        <div className="flex flex-col gap-1">
          <div className="relative h-7">
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
              className="absolute inset-0 cursor-pointer touch-none select-none rounded-md bg-surface-sunken"
              data-testid="scrubber"
            >
              <div
                className="absolute inset-y-0 left-0 rounded-l-md bg-surface-hover"
                style={{ width: `${pct}%` }}
              />
              <div
                className="absolute inset-y-0 w-0.5 -translate-x-1/2 bg-fg"
                style={{ left: `${pct}%` }}
                aria-hidden
              >
                <div className="absolute -top-1 left-1/2 h-2 w-2 -translate-x-1/2 rounded-full bg-fg" />
              </div>
            </div>
            {/* Markers sit above the track (not inside the slider) so they stay clickable without nesting controls. */}
            <EventMarkers markers={markers} maxMinute={max} onJump={onJump} />
          </div>
          {baselineMarkers.length > 0 && (
            <div className="relative h-4 rounded-sm" aria-hidden>
              <span className="absolute -left-0 top-0 text-micro text-fg-subtle">baseline</span>
              <EventMarkers markers={baselineMarkers} maxMinute={max} onJump={onJump} lane="baseline" />
            </div>
          )}
          <div className="num flex justify-between text-micro text-fg-subtle">
            <span>{clock(0)}Z</span>
            <span className="flex gap-3">
              {MARKER_LEGEND.map(([k, label]) => (
                <span key={k} className="hidden items-center gap-1 2xl:inline-flex">
                  <MarkerGlyph kind={k} /> {label}
                </span>
              ))}
            </span>
            <span>{clock(max)}Z</span>
          </div>
        </div>
      </div>
    </StateFrame>
  );
}
