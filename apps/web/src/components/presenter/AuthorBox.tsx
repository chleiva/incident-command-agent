/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Free text → Scenario Author agent → a validated scenario preview with its screening findings → start.
 * The text is untrusted: it is screened server-side and reaches the agents only as data.
 * Async: the author runs in the background (it can take a minute or more); `onAuthor` polls the draft and reports
 * progress, and a failure is shown calmly with the reasons.
 */
import type { AuthorScenarioResponse } from '@ica/schema/browser';
import { useId, useState } from 'react';
import { formatInt } from '../../lib/format';
import { Icon } from '../ui/Icon';
import { AiDraftedBadge, Badge, Button, cx } from '../ui/primitives';

const MAX = 8000;

export function AuthorBox({
  onAuthor,
  onStart,
  initialResult = null,
  initialText = '',
}: {
  onAuthor: (text: string, onProgress?: (elapsedMs: number) => void) => Promise<AuthorScenarioResponse>;
  onStart: (scenarioId: string) => void;
  initialResult?: AuthorScenarioResponse | null;
  initialText?: string;
}) {
  const id = useId();
  const [text, setText] = useState(initialText);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AuthorScenarioResponse | null>(initialResult);
  const [elapsedMs, setElapsedMs] = useState(0);

  const submit = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    setElapsedMs(0);
    try {
      setResult(await onAuthor(text, setElapsedMs));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const s = result?.scenario;
  const verdict = result?.screening.verdict;

  return (
    <section
      aria-labelledby={`${id}-h`}
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4 shadow-e1"
    >
      <div>
        <h2 id={`${id}-h`} className="text-title text-fg">
          Write a scenario
        </h2>
        <p className="text-caption text-fg-muted">
          Describe an incident in plain words. The Scenario Author agent turns it into a validated scenario
          for the fictional carrier.
        </p>
      </div>
      <label htmlFor={`${id}-t`} className="sr-only">
        Scenario description
      </label>
      <textarea
        id={`${id}-t`}
        value={text}
        maxLength={MAX}
        rows={4}
        onChange={(e) => setText(e.target.value)}
        placeholder="e.g. A catering truck clips the forward door of an A320 at Palma during turnaround; 180 passengers, two wheelchair users…"
        className="w-full resize-y rounded-md border border-border-control/70 bg-surface-sunken p-3 text-body text-fg placeholder:text-fg-subtle"
      />
      <div className="flex items-center gap-2">
        <Button variant="primary" size="sm" icon="sparkle" disabled={!text.trim() || busy} onClick={submit}>
          {busy ? 'Authoring…' : 'Author scenario'}
        </Button>
        <span className="num ml-auto text-micro text-fg-subtle">
          {formatInt(text.length)} / {formatInt(MAX)}
        </span>
      </div>
      {busy && (
        <p role="status" aria-live="polite" className="flex items-center gap-2 text-caption text-fg-muted">
          <Icon name="sparkle" size={12} />
          The Scenario Author is writing and validating your scenario
          {elapsedMs >= 1000 ? ` (${Math.round(elapsedMs / 1000)} s)` : ''}. This usually takes a minute or
          two; you can keep working.
        </p>
      )}
      {error && (
        <p role="alert" className="text-caption text-critical">
          {error}
        </p>
      )}
      {result && (
        <div className="flex flex-col gap-2 border-t border-border pt-3" aria-live="polite">
          <div className="flex flex-wrap items-center gap-2">
            <span className="caps text-fg-muted">Screening</span>
            <Badge
              tone={verdict === 'rejected' ? 'critical' : verdict === 'neutralised' ? 'warning' : 'neutral'}
              icon={verdict === 'clean' ? 'check' : 'shield'}
            >
              {verdict}
            </Badge>
            {result.screening.findings.map((f) => (
              <Badge key={f.pattern + f.excerpt} tone="neutral" title={f.excerpt}>
                {f.pattern}
              </Badge>
            ))}
          </div>
          {result.errors && result.errors.length > 0 && (
            <ul className="list-disc pl-5 text-caption text-critical">
              {result.errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          )}
          {s && (
            <article className="rounded-md bg-surface-sunken p-3">
              <div className="flex items-center gap-2">
                <AiDraftedBadge />
                <Badge>{s.aircraft.station}</Badge>
                <Badge>
                  {s.aircraft.tail} · {s.aircraft.type}
                </Badge>
                <span className="ml-auto inline-flex items-center gap-1 text-micro text-fg-muted">
                  <Icon name="check" size={12} /> schema valid
                </span>
              </div>
              <h3 className="mt-2 text-body-lg text-fg">{s.title}</h3>
              <p className="mt-1 line-clamp-3 text-caption text-fg-muted">{s.trigger.description}</p>
              <p className="num mt-1 text-micro text-fg-subtle">
                {s.world.cohorts.length} cohorts ·{' '}
                {formatInt(s.world.cohorts.reduce((n, c) => n + c.count, 0))} passengers · {s.twists.length}{' '}
                twists · {s.world.engineers.length} engineers
              </p>
              <Button
                className={cx('mt-3')}
                variant="approve"
                size="sm"
                icon="play"
                onClick={() => onStart(s.id)}
              >
                Start this scenario
              </Button>
            </article>
          )}
        </div>
      )}
    </section>
  );
}
