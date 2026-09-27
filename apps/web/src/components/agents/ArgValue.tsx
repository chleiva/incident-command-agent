/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Rendering of tool-call arguments (live run 2: object/array args printed as `citations=[object Object]+[object
 * Object]`). One shared renderer for every card that shows args (tool call, proposal/decision, blocked call):
 * - citations → source chips (sourceId + title; the quote on hover and on expand);
 * - arrays of strings → a bullet list;
 * - objects → a compact key/value list;
 * - long strings → truncated with "Show more".
 * `argSummary` is the one-line text form used in collapsed rows.
 */
import { useState } from 'react';
import { cx } from '../ui/primitives';
import { Icon } from '../ui/Icon';

export interface CitationLike {
  sourceId: string;
  title?: string;
  quote?: string;
  url?: string;
  chunkId?: string;
}

/** Characters shown before a long string is truncated. */
export const ARG_TRUNCATE_AT = 240;

export function isCitationLike(v: unknown): v is CitationLike {
  return (
    !!v && typeof v === 'object' && !Array.isArray(v) && typeof (v as CitationLike).sourceId === 'string'
  );
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** One-line text for a single argument value (never `[object Object]`). */
export function argSummary(v: unknown, max = 80): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'string') return clip(v, max);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) {
    if (!v.length) return '[]';
    if (v.every(isCitationLike)) {
      return clip(
        `${v.length} source${v.length > 1 ? 's' : ''}: ${v.map((c) => c.sourceId).join(', ')}`,
        max,
      );
    }
    if (v.every((x) => typeof x === 'string' || typeof x === 'number'))
      return clip(v.map(String).join('; '), max);
    return `${v.length} item${v.length > 1 ? 's' : ''}`;
  }
  if (isCitationLike(v)) return clip(`source: ${v.sourceId}`, max);
  const entries = Object.entries(v as Record<string, unknown>);
  return clip(
    `{${entries.map(([k, x]) => `${k}: ${typeof x === 'object' && x !== null ? '…' : String(x)}`).join(', ')}}`,
    max,
  );
}

/** Compact one-line args (`key=value …`) for a collapsed card row. */
export function compactArgs(args: Record<string, unknown>, keys = 3): string {
  return Object.entries(args)
    .filter(([k]) => k !== 'body' && k !== 'brief')
    .slice(0, keys)
    .map(([k, v]) => `${k}=${argSummary(v, 60)}`)
    .join(' ');
}

export function CitationChips({ citations }: { citations: CitationLike[] }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <span className="flex flex-col gap-1">
      <span className="flex flex-wrap gap-1">
        {citations.map((c, i) => {
          const key = `${c.sourceId}-${c.chunkId ?? i}`;
          return (
            <button
              key={key}
              type="button"
              data-citation-chip
              title={c.quote ? `“${c.quote}”` : undefined}
              aria-expanded={open === key}
              onClick={() => setOpen(open === key ? null : key)}
              className="inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-surface-sunken px-2 py-0.5 text-micro text-fg-muted hover:text-fg"
            >
              <Icon name="link" size={10} className="shrink-0 text-fg-subtle" />
              <span className="font-mono">{c.sourceId}</span>
              {c.title && <span className="truncate">· {c.title}</span>}
            </button>
          );
        })}
      </span>
      {citations.map((c, i) => {
        const key = `${c.sourceId}-${c.chunkId ?? i}`;
        return open === key && c.quote ? (
          <blockquote key={key} className="border-l-2 border-border-control pl-2 text-caption text-fg-muted">
            “{c.quote}”
          </blockquote>
        ) : null;
      })}
    </span>
  );
}

export function LongText({ text, max = ARG_TRUNCATE_AT }: { text: string; max?: number }) {
  const [more, setMore] = useState(false);
  if (text.length <= max) return <span className="whitespace-pre-wrap break-words">{text}</span>;
  return (
    <span className="whitespace-pre-wrap break-words">
      {more ? text : `${text.slice(0, max - 1)}…`}{' '}
      <button
        type="button"
        onClick={() => setMore(!more)}
        className="text-micro text-fg-subtle underline underline-offset-2"
      >
        {more ? 'Show less' : 'Show more'}
      </button>
    </span>
  );
}

/** One argument value, rendered by shape. */
export function ArgValue({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="text-fg-subtle">—</span>;
  if (typeof value === 'string') return <LongText text={value} />;
  if (typeof value === 'number' || typeof value === 'boolean')
    return <span className="font-mono">{String(value)}</span>;
  if (Array.isArray(value)) {
    if (!value.length) return <span className="text-fg-subtle">none</span>;
    if (value.every(isCitationLike)) return <CitationChips citations={value} />;
    return (
      <ul className="list-disc pl-4">
        {value.map((x, i) => (
          <li key={i}>{typeof x === 'string' ? <LongText text={x} max={160} /> : <ArgValue value={x} />}</li>
        ))}
      </ul>
    );
  }
  if (isCitationLike(value)) return <CitationChips citations={[value]} />;
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.length) return <span className="text-fg-subtle">{'{}'}</span>;
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2">
      {entries.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-fg-subtle">{k}</dt>
          <dd className="min-w-0">
            {typeof v === 'object' && v !== null ? argSummary(v, 120) : <ArgValue value={v} />}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** All arguments as a key/value list. */
export function ArgsList({
  args,
  omit = [],
  limit,
  className,
}: {
  args: Record<string, unknown>;
  omit?: string[];
  limit?: number;
  className?: string;
}) {
  const entries = Object.entries(args).filter(([k]) => !omit.includes(k));
  if (!entries.length) return null;
  return (
    <dl
      data-args-list
      className={cx('grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-caption', className)}
    >
      {entries.slice(0, limit ?? entries.length).map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-fg-subtle">{k}</dt>
          <dd className="min-w-0 text-fg-muted">
            <ArgValue value={v} />
          </dd>
        </div>
      ))}
    </dl>
  );
}
