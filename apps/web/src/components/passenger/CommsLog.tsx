/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** Every passenger communication with its time, channel, audience and status. Select one to show it. */
import type { PassengerMessage } from '@ica/schema/browser';
import { StateFrame, cx, type LoadStatus, type Tone } from '../ui/primitives';

const STATUS: Record<PassengerMessage['status'], { label: string; tone: Tone }> = {
  draft: { label: 'Draft', tone: 'neutral' },
  pending_approval: { label: 'Awaiting approval', tone: 'warning' },
  sent: { label: 'Sent', tone: 'neutral' },
  blocked: { label: 'Blocked', tone: 'critical' },
};

export function CommsLog({
  messages,
  selectedId,
  onSelect,
  clock,
  cohortSize,
  status = 'ready',
  error,
}: {
  messages: PassengerMessage[];
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  /** Sim minute → "HH:MM". */
  clock: (minute: number) => string;
  cohortSize?: (ids: string[]) => number;
  status?: LoadStatus;
  error?: string | null;
}) {
  const sorted = [...messages].sort(
    (a, b) => (b.sentAtMinute ?? 1e9) - (a.sentAtMinute ?? 1e9) || b.id.localeCompare(a.id),
  );
  return (
    <StateFrame
      status={status}
      error={error}
      empty={messages.length === 0}
      emptyText="No passenger communications yet."
    >
      <ol className="flex flex-col gap-1" aria-label="Communications log">
        {sorted.map((m) => {
          const s = STATUS[m.status];
          const active = m.id === selectedId;
          return (
            <li key={m.id}>
              <button
                type="button"
                aria-pressed={active}
                onClick={() => onSelect?.(m.id)}
                className={cx(
                  'flex w-full flex-col gap-0.5 rounded-md px-2 py-1 text-left hover:bg-surface-hover',
                  active && 'bg-surface-hover',
                )}
              >
                <span className="flex items-center gap-2 text-caption">
                  <span className="num text-fg">
                    {m.sentAtMinute !== undefined ? clock(m.sentAtMinute) : '--:--'}
                  </span>
                  <span className="uppercase text-fg-subtle">{m.channel}</span>
                  <span className="num text-fg-subtle">
                    {cohortSize ? `${cohortSize(m.cohortIds)} pax` : `${m.cohortIds.length} cohorts`}
                  </span>
                  <span
                    className={cx(
                      'ml-auto',
                      s.tone === 'warning'
                        ? 'text-warning'
                        : s.tone === 'critical'
                          ? 'text-critical'
                          : 'text-fg-muted',
                    )}
                  >
                    {s.label}
                  </span>
                </span>
                <span className="line-clamp-1 text-caption text-fg-muted">{m.body}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </StateFrame>
  );
}
