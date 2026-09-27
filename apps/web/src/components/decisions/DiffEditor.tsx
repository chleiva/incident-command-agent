/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Inline JSON editor for a proposal's `args` → `editedArgs`, with a live diff and schema hints taken from the
 * original payload (type per key; removed keys and type changes are flagged).
 */
import { useId, useMemo, useState } from 'react';
import { Button, cx } from '../ui/primitives';

type Json = Record<string, unknown>;

const typeOf = (v: unknown): string =>
  Array.isArray(v) ? `${v.length ? typeOf(v[0]) : 'unknown'}[]` : v === null ? 'null' : typeof v;

export interface DiffLine {
  key: string;
  kind: 'same' | 'changed' | 'added' | 'removed';
  before?: unknown;
  after?: unknown;
  typeChanged: boolean;
}

export function diffArgs(before: Json, after: Json): DiffLine[] {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  return keys.map((key) => {
    const inB = key in before;
    const inA = key in after;
    const b = before[key];
    const a = after[key];
    const kind = !inA
      ? 'removed'
      : !inB
        ? 'added'
        : JSON.stringify(a) === JSON.stringify(b)
          ? 'same'
          : 'changed';
    return { key, kind, before: b, after: a, typeChanged: inA && inB && typeOf(a) !== typeOf(b) };
  });
}

const short = (v: unknown) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s && s.length > 90 ? `${s.slice(0, 87)}…` : s;
};

export function DiffEditor({
  original,
  onSubmit,
  onCancel,
}: {
  original: Json;
  onSubmit: (edited: Json) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const [text, setText] = useState(() => JSON.stringify(original, null, 2));
  const parsed = useMemo((): { ok: true; value: Json } | { ok: false; error: string } => {
    try {
      const v = JSON.parse(text) as unknown;
      if (!v || typeof v !== 'object' || Array.isArray(v))
        return { ok: false, error: 'The payload must be a JSON object.' };
      return { ok: true, value: v as Json };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }, [text]);
  const lines = parsed.ok ? diffArgs(original, parsed.value) : [];
  const changed = lines.filter((l) => l.kind !== 'same');
  const blocking = lines.some((l) => l.kind === 'removed' || l.typeChanged);

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={`${id}-json`} className="caps text-fg-muted">
        Edit payload
      </label>
      <p id={`${id}-hints`} className="text-micro text-fg-subtle">
        Schema:{' '}
        {Object.entries(original)
          .map(([k, v]) => `${k}: ${typeOf(v)}`)
          .join(' · ')}
      </p>
      <textarea
        id={`${id}-json`}
        aria-describedby={`${id}-hints ${id}-status`}
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
        rows={Math.min(12, text.split('\n').length + 1)}
        className="w-full resize-y rounded-md border border-border-control/70 bg-surface-sunken p-2 font-mono text-caption text-fg"
      />
      <div id={`${id}-status`} aria-live="polite" className="text-caption">
        {!parsed.ok ? (
          <span className="text-critical">Invalid JSON: {parsed.error}</span>
        ) : changed.length === 0 ? (
          <span className="text-fg-subtle">No changes yet.</span>
        ) : (
          <ul className="flex flex-col gap-1" aria-label="Changes">
            {changed.map((l) => (
              <li key={l.key} className="rounded-sm bg-surface-sunken px-2 py-1 font-mono">
                <span className="text-fg-muted">{l.key}</span>{' '}
                {l.kind === 'removed' ? (
                  <span className="text-critical">removed (required by the tool)</span>
                ) : (
                  <>
                    {l.kind === 'changed' && (
                      <span className="text-fg-subtle line-through">{short(l.before)}</span>
                    )}{' '}
                    <span className={cx(l.typeChanged ? 'text-critical' : 'text-fg')}>{short(l.after)}</span>
                    {l.typeChanged && <span className="text-critical"> (type changed)</span>}
                    {l.kind === 'added' && <span className="text-warning"> (new field)</span>}
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex gap-2">
        <Button
          variant="approve"
          size="sm"
          disabled={!parsed.ok || changed.length === 0 || blocking}
          onClick={() => parsed.ok && onSubmit(parsed.value)}
        >
          Approve with edits
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
