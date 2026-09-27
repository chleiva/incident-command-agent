/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** The scenario library: station, aircraft type, trigger and "inspired by" provenance; start with or without a baseline. */
import type { ScenarioSummary } from '@ica/schema/browser';
import { useId, useState } from 'react';
import { Icon } from '../ui/Icon';
import { Badge, Button, Skeleton, StateFrame, type LoadStatus } from '../ui/primitives';

export interface StartOptions {
  withBaseline: boolean;
  speed: number;
}

export function ScenarioPicker({
  scenarios,
  onStart,
  unavailableReason,
  starting,
  status = 'ready',
  error,
  speeds = [1, 6, 15, 30],
}: {
  scenarios: ScenarioSummary[];
  onStart: (scenarioId: string, opts: StartOptions) => void;
  unavailableReason?: (id: string) => string | null;
  starting?: string | null;
  status?: LoadStatus;
  error?: string | null;
  speeds?: number[];
}) {
  const id = useId();
  const [withBaseline, setWithBaseline] = useState(true);
  const [speed, setSpeed] = useState(6);
  return (
    <section aria-labelledby={`${id}-h`} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <h2 id={`${id}-h`} className="text-heading text-fg">
            Scenario library
          </h2>
          <p className="text-body text-fg-muted">
            Ground and pre-departure incidents at real airports, for a fictional carrier.
          </p>
        </div>
        <div className="ml-auto flex items-center gap-3 text-body text-fg-muted">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={withBaseline}
              onChange={(e) => setWithBaseline(e.target.checked)}
              className="h-4 w-4 accent-[rgb(var(--c-fg))]"
            />
            Run the human baseline alongside
          </label>
          <label className="flex items-center gap-2">
            Speed
            <select
              value={speed}
              onChange={(e) => setSpeed(Number(e.target.value))}
              className="h-7 rounded-md border border-border-control/70 bg-surface-raised px-2 text-body text-fg"
            >
              {speeds.map((s) => (
                <option key={s} value={s}>
                  {s}×
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>
      <StateFrame
        status={status}
        error={error}
        empty={scenarios.length === 0}
        emptyText="No scenarios found. Check the API or author one below."
        skeleton={
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <Skeleton key={i} className="h-40" />
            ))}
          </div>
        }
      >
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {scenarios.map((s) => {
            const reason = unavailableReason?.(s.id) ?? null;
            return (
              <li
                key={s.id}
                className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-4 shadow-e1"
                data-scenario={s.id}
              >
                <div className="flex items-center gap-2">
                  <span className="num font-mono text-caption text-fg-subtle">
                    {s.id.slice(0, 3).toUpperCase()}
                  </span>
                  <Badge>{s.station}</Badge>
                  <Badge>{s.aircraftType}</Badge>
                  {s.visibility === 'private' && <Badge tone="ai">authored</Badge>}
                </div>
                <h3 className="text-title text-fg">{s.title}</h3>
                <p className="text-caption text-fg-muted">
                  {s.triggerType.replace(/-/g, ' ')} · {s.twistCount} twist{s.twistCount === 1 ? '' : 's'}
                </p>
                <div className="text-caption text-fg-subtle">
                  {s.inspiredBy.length ? (
                    <span className="flex flex-wrap items-center gap-1">
                      Inspired by
                      {s.inspiredBy.map((r) => (
                        <a
                          key={r.sourceId}
                          href={r.url}
                          target="_blank"
                          rel="noreferrer noopener"
                          title={r.note}
                          className="underline decoration-border-control underline-offset-2 hover:text-fg"
                        >
                          {r.sourceId}
                        </a>
                      ))}
                    </span>
                  ) : (
                    'Provenance: no verified source recorded'
                  )}
                </div>
                <div className="mt-auto flex items-center gap-2 pt-1">
                  <Button
                    variant="primary"
                    size="sm"
                    icon="play"
                    disabled={!!reason || !!starting}
                    onClick={() => onStart(s.id, { withBaseline, speed })}
                    aria-label={`Start ${s.title}`}
                  >
                    {starting === s.id ? 'Starting…' : 'Start'}
                  </Button>
                  {reason && (
                    <span className="inline-flex items-center gap-1 text-micro text-fg-subtle">
                      <Icon name="info" size={12} /> {reason}
                    </span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </StateFrame>
    </section>
  );
}
