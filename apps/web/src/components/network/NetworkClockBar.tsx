/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** The UTC clock over the live map, with "Live", a time-of-day slider and a speed selector (presenter aids). */
import { NETWORK_SPEEDS, useNetworkClock } from '../../lib/networkClock';
import { cx } from '../ui/primitives';

const pad = (n: number) => String(n).padStart(2, '0');

export function NetworkClockBar({ t }: { t: number }) {
  const { live, speed, setSpeed, setMinuteOfDay, goLive } = useNetworkClock();
  const d = new Date(t);
  const minute = d.getUTCHours() * 60 + d.getUTCMinutes();
  return (
    <div
      className="flex items-center gap-3 rounded-lg border border-border bg-surface/95 px-3 py-1.5 shadow-e2 backdrop-blur"
      data-testid="network-clock"
    >
      <span
        className="num text-title text-fg"
        aria-live="off"
        aria-label={`Network time ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`}
      >
        {pad(d.getUTCHours())}:{pad(d.getUTCMinutes())}
        <span className="text-fg-muted">:{pad(d.getUTCSeconds())}</span>
        <span className="ml-1 text-caption text-fg-subtle">UTC</span>
      </span>
      <button
        type="button"
        onClick={goLive}
        aria-pressed={live}
        className={cx(
          'inline-flex h-6 items-center gap-1 rounded-full px-2 text-caption',
          live
            ? 'bg-critical-bg text-critical'
            : 'border border-border-control/60 text-fg-muted hover:text-fg',
        )}
        title="Follow the real wall clock"
      >
        <span className={cx('h-1.5 w-1.5 rounded-full', live ? 'bg-critical' : 'bg-fg-subtle')} aria-hidden />
        Live
      </button>
      <label className="flex items-center gap-2 text-caption text-fg-muted">
        <span className="sr-only">Time of day (UTC)</span>
        <input
          type="range"
          min={0}
          max={1439}
          step={5}
          value={minute}
          onChange={(e) => setMinuteOfDay(Number(e.target.value))}
          className="w-40 accent-[rgb(var(--c-brand-accent))]"
          aria-valuetext={`${pad(Math.floor(minute / 60))}:${pad(minute % 60)} UTC`}
        />
      </label>
      <label className="flex items-center gap-1 text-caption text-fg-muted">
        <span>Speed</span>
        <select
          aria-label="Network clock speed"
          value={speed}
          onChange={(e) => setSpeed(Number(e.target.value))}
          className="h-6 rounded-md border border-border-control/60 bg-surface px-1 text-caption text-fg"
        >
          {NETWORK_SPEEDS.map((s) => (
            <option key={s} value={s}>
              {s}×
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
