/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * "Report incident" for a flight: a simple list of the incident types that apply to the flight's phase (one plain
 * line each), an optional free-text box, a one-glance preview of the scenario that will run, and Start. Picking a
 * type builds the scenario from the flight's context with the templates (free, instant; the server rebuilds it the
 * same way). Free text adds one Scenario Author step (an LLM call). No wizard.
 */
import type { DaySchedule, NetworkFlight } from '@ica/network';
import type * as Templates from '@ica/network/templates';
import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useId, useMemo, useState } from 'react';
import { Icon } from '../ui/Icon';
import { Badge, Button, cx } from '../ui/primitives';

type TemplatesLib = typeof Templates;

export interface ReportRequest {
  incidentType: string;
  text?: string;
  withBaseline: boolean;
  speed: number;
}

const OTHER = 'other';

/** Load the templates (and the ten template scenarios) only when the dialog opens. */
function useTemplates(open: boolean): TemplatesLib | null {
  const [lib, setLib] = useState<TemplatesLib | null>(null);
  useEffect(() => {
    if (!open || lib) return;
    let alive = true;
    void import('@ica/network/templates').then((m) => alive && setLib(m));
    return () => {
      alive = false;
    };
  }, [open, lib]);
  return lib;
}

export function ReportIncidentDialog({
  open,
  onOpenChange,
  schedule,
  flight,
  t,
  mode = 'live',
  onStart,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  schedule: DaySchedule;
  flight: NetworkFlight;
  /** Network time of the report (frozen when the dialog opens). */
  t: number;
  mode?: 'live' | 'mock';
  onStart: (req: ReportRequest) => Promise<string | null>;
}) {
  const id = useId();
  const lib = useTemplates(open);
  const [atMs, setAtMs] = useState(t);
  const [selected, setSelected] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [withBaseline, setWithBaseline] = useState(true);
  const [speed, setSpeed] = useState(6);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setAtMs(t);
      setSelected(null);
      setText('');
      setError(null);
      setBusy(false);
    }
    // Freeze the report time when the dialog opens.
  }, [open, flight.flight]);

  const ctx = useMemo(
    () => lib?.incidentContext(schedule, flight.flight, atMs),
    [lib, schedule, flight, atMs],
  );
  const options = useMemo(() => (lib && ctx ? lib.incidentTypesFor(ctx) : []), [lib, ctx]);
  const preview = useMemo(() => {
    if (!lib || !selected || selected === OTHER) return null;
    try {
      return lib.buildScenarioFromFlight(schedule, flight.flight, selected, { atMs }).preview;
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }, [lib, selected, schedule, flight, atMs]);

  const needsText = selected === OTHER;
  const canStart =
    !!selected && !busy && (!needsText || text.trim().length > 0) && !(preview && 'error' in preview);

  const start = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    const runId = await onStart({
      incidentType: selected,
      ...(text.trim() ? { text: text.trim() } : {}),
      withBaseline,
      speed,
    });
    if (!runId) {
      setBusy(false);
      setError('The run could not be started. Check the message above and try again.');
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-bg/70" />
        <Dialog.Content
          data-testid="report-dialog"
          className="fixed left-1/2 top-1/2 z-50 flex max-h-[90vh] w-[min(760px,calc(100vw-24px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-lg border border-border bg-surface-raised shadow-e3 outline-none"
        >
          <div className="flex items-start gap-3 border-b border-border px-5 py-4">
            <div className="min-w-0 flex-1">
              <Dialog.Title className="text-title text-fg">
                Report incident · <span className="num">{flight.flight}</span>
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-caption text-fg-muted">
                <span className="num">
                  {flight.from} → {flight.to} · {flight.tail} ({flight.type})
                </span>
                {ctx ? ` · ${ctx.phase.replace('_', ' ')} · incident at ${ctx.station}` : ''}
              </Dialog.Description>
            </div>
            <Dialog.Close
              className="rounded-md p-1 text-fg-muted hover:bg-surface-hover hover:text-fg"
              aria-label="Close"
            >
              <Icon name="close" size={16} />
            </Dialog.Close>
          </div>

          <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-y-auto p-5 md:grid-cols-[1fr_280px]">
            <div className="flex min-w-0 flex-col gap-3">
              <fieldset>
                <legend className="mb-2 text-caption font-semibold uppercase tracking-wide text-fg-muted">
                  What is happening?
                </legend>
                {!lib && <p className="text-caption text-fg-muted">Loading incident types…</p>}
                <div role="radiogroup" aria-label="Incident type" className="flex flex-col gap-1">
                  {options.map((o) => (
                    <label
                      key={o.type.id}
                      className={cx(
                        'flex items-start gap-2 rounded-md border px-3 py-2',
                        !o.enabled
                          ? 'cursor-not-allowed border-border/50 opacity-60'
                          : selected === o.type.id
                            ? 'cursor-pointer border-brand-accent bg-surface-hover'
                            : 'cursor-pointer border-border hover:bg-surface-hover',
                      )}
                      data-incident-type={o.type.id}
                    >
                      <input
                        type="radio"
                        name={`${id}-type`}
                        value={o.type.id}
                        disabled={!o.enabled}
                        checked={selected === o.type.id}
                        onChange={() => setSelected(o.type.id)}
                        className="mt-1 accent-[rgb(var(--c-brand-accent))]"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2 text-body text-fg">
                          {o.type.label}
                          {o.type.category === 'airborne' && <Badge icon="plane">airborne</Badge>}
                        </span>
                        <span className="block text-caption text-fg-muted">{o.type.description}</span>
                        {!o.enabled && o.reason && (
                          <span className="block text-caption text-fg-subtle">{o.reason}</span>
                        )}
                      </span>
                    </label>
                  ))}
                  {lib && (
                    <label
                      className={cx(
                        'flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2',
                        selected === OTHER
                          ? 'border-brand-accent bg-surface-hover'
                          : 'border-border hover:bg-surface-hover',
                      )}
                      data-incident-type={OTHER}
                    >
                      <input
                        type="radio"
                        name={`${id}-type`}
                        value={OTHER}
                        checked={selected === OTHER}
                        onChange={() => setSelected(OTHER)}
                        className="mt-1 accent-[rgb(var(--c-brand-accent))]"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block text-body text-fg">Something else</span>
                        <span className="block text-caption text-fg-muted">
                          Describe it below; the Scenario Author writes the scenario from your words and this
                          flight.
                        </span>
                      </span>
                    </label>
                  )}
                </div>
              </fieldset>

              <label className="flex flex-col gap-1">
                <span className="text-caption font-semibold uppercase tracking-wide text-fg-muted">
                  {needsText ? "Describe what's happening" : 'Add details (optional)'}
                </span>
                <textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  rows={3}
                  maxLength={4000}
                  placeholder="e.g. Engineer on stand says the leak is getting worse; two PRM passengers already on board."
                  className="rounded-md border border-border-control/70 bg-surface-sunken p-2 text-body text-fg placeholder:text-fg-subtle"
                />
                {text.trim() && (
                  <span className="text-caption text-fg-muted" data-testid="author-note">
                    {mode === 'mock'
                      ? 'Mock mode: your text is screened and added to the scenario; no LLM call.'
                      : 'The cockpit opens at once; the Scenario Author adds your details before the world starts (under a minute). Your text is screened and treated as data.'}
                  </span>
                )}
              </label>
            </div>

            <aside
              aria-label="Scenario preview"
              className="flex flex-col gap-2 rounded-md border border-border bg-surface p-3"
            >
              <h3 className="text-caption font-semibold uppercase tracking-wide text-fg-muted">Will run</h3>
              {!selected && <p className="text-caption text-fg-muted">Pick an incident type.</p>}
              {selected === OTHER && (
                <p className="text-caption text-fg-muted">
                  The Scenario Author builds the scenario from your description and this flight's context.
                </p>
              )}
              {preview && 'error' in preview && (
                <p role="alert" className="text-caption text-critical">
                  {preview.error}
                </p>
              )}
              {preview && !('error' in preview) && (
                <>
                  <p className="text-body text-fg" data-testid="preview-trigger">
                    {preview.trigger}
                  </p>
                  <ul className="flex flex-col gap-1 text-caption text-fg-muted">
                    {preview.facts.map((f) => (
                      <li key={f}>{f}</li>
                    ))}
                  </ul>
                  {preview.twists.length > 0 && (
                    <p className="text-caption text-fg-subtle">Twists: {preview.twists.join(' · ')}</p>
                  )}
                  {options.find((o) => o.type.id === selected)?.type.category === 'airborne' && (
                    <p className="text-caption text-fg" data-testid="commander-authority-note">
                      The commander flies and decides the aircraft. The agents only prepare options and the
                      ground; instructing the crew is blocked.
                    </p>
                  )}
                </>
              )}
              {mode === 'mock' && selected && (
                <p className="mt-auto text-caption text-fg-subtle">
                  Mock mode replays a recorded response, with its identifiers moved onto this flight.
                </p>
              )}
            </aside>
          </div>

          <div className="flex flex-wrap items-center gap-3 border-t border-border px-5 py-3 text-body text-fg-muted">
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
                {[1, 6, 15, 30].map((s) => (
                  <option key={s} value={s}>
                    {s}×
                  </option>
                ))}
              </select>
            </label>
            {error && (
              <span role="alert" className="text-caption text-critical">
                {error}
              </span>
            )}
            <Button
              variant="primary"
              icon="play"
              className="ml-auto"
              disabled={!canStart}
              onClick={() => void start()}
            >
              {busy ? 'Starting…' : 'Start'}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
