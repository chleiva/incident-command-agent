/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Monospace JSON viewer for the audit: "Text" (the exact JSON, pretty-printed, never cut) and "Tree" (collapsible
 * nodes, children rendered only when opened). JSON over 1 MB starts in the tree and renders its text on request.
 * Copy and Download act on the whole value.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { LARGE_JSON_BYTES, formatBytes } from '../../audit/audit';
import { downloadBlob } from '../../lib/evidencePdf';
import { Icon } from '../ui/Icon';
import { cx } from '../ui/primitives';

const CHILD_PAGE = 200;

export function jsonText(value: unknown): string {
  if (value === undefined) return '';
  return JSON.stringify(value, null, 2) ?? '';
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function PanelActions({
  text,
  filename,
  label,
}: {
  text: () => string;
  filename: string;
  label: string;
}) {
  const [copied, setCopied] = useState<'idle' | 'ok' | 'failed'>('idle');
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        className="inline-flex h-6 items-center gap-1 rounded-sm border border-border-control/60 px-2 text-micro text-fg-muted hover:bg-surface-hover hover:text-fg"
        onClick={async () => {
          setCopied((await copyText(text())) ? 'ok' : 'failed');
          setTimeout(() => setCopied('idle'), 1500);
        }}
        aria-label={`Copy ${label}`}
      >
        <Icon name={copied === 'ok' ? 'check' : 'file'} size={11} />
        {copied === 'ok' ? 'Copied' : copied === 'failed' ? 'Copy failed' : 'Copy'}
      </button>
      <button
        type="button"
        className="inline-flex h-6 items-center gap-1 rounded-sm border border-border-control/60 px-2 text-micro text-fg-muted hover:bg-surface-hover hover:text-fg"
        onClick={() => downloadBlob(text(), filename, 'application/json')}
        aria-label={`Download ${label}`}
      >
        <Icon name="download" size={11} />
        Download
      </button>
    </div>
  );
}

export function JsonViewer({
  value,
  label,
  filename,
  maxHeight = 'max-h-[28rem]',
  testId,
}: {
  value: unknown;
  /** Accessible name of the viewer ("Raw request JSON"). */
  label: string;
  filename: string;
  maxHeight?: string;
  testId?: string;
}) {
  const text = useMemo(() => jsonText(value), [value]);
  const bytes = useMemo(() => new Blob([text]).size, [text]);
  const large = bytes > LARGE_JSON_BYTES;
  const [mode, setMode] = useState<'text' | 'tree'>(large ? 'tree' : 'text');
  const [full, setFull] = useState(!large);
  const modeButton = (m: 'text' | 'tree', name: string) => (
    <button
      type="button"
      aria-pressed={mode === m}
      onClick={() => setMode(m)}
      className={cx(
        'h-6 rounded-sm px-2 text-micro',
        mode === m ? 'bg-surface-hover text-fg' : 'text-fg-muted hover:text-fg',
      )}
    >
      {name}
    </button>
  );
  return (
    <div className="flex min-w-0 flex-col gap-1" data-testid={testId}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1" role="group" aria-label={`${label} view`}>
          {modeButton('text', 'Text')}
          {modeButton('tree', 'Tree')}
          <span className="ml-1 text-micro text-fg-subtle">{formatBytes(bytes)}</span>
        </div>
        <PanelActions text={() => text} filename={filename} label={label} />
      </div>
      <div
        role="region"
        aria-label={label}
        tabIndex={0}
        className={cx(
          'overflow-auto rounded-md border border-border bg-surface-sunken p-2 font-mono text-[12px] leading-[1.45] text-fg',
          maxHeight,
        )}
      >
        {mode === 'text' ? (
          full ? (
            <pre className="whitespace-pre-wrap break-words" data-json-text>
              {text}
            </pre>
          ) : (
            <div className="flex flex-col items-start gap-2 font-sans text-caption text-fg-muted">
              This JSON is {formatBytes(bytes)}. Rendering it all may be slow.
              <button
                type="button"
                className="rounded-sm border border-border-control/60 px-2 py-0.5 text-fg hover:bg-surface-hover"
                onClick={() => setFull(true)}
              >
                Load full
              </button>
            </div>
          )
        ) : (
          <JsonNode value={value} depth={0} openDepth={large ? 1 : 2} />
        )}
      </div>
    </div>
  );
}

function Primitive({ v }: { v: unknown }): ReactNode {
  if (v === null) return <span className="text-fg-subtle">null</span>;
  if (typeof v === 'string')
    return <span className="whitespace-pre-wrap break-words text-fg">&quot;{v}&quot;</span>;
  if (typeof v === 'number') return <span className="text-ai">{String(v)}</span>;
  if (typeof v === 'boolean') return <span className="text-ai">{String(v)}</span>;
  return <span className="text-fg-subtle">{String(v)}</span>;
}

function JsonNode({
  name,
  value,
  depth,
  openDepth,
}: {
  name?: string | number;
  value: unknown;
  depth: number;
  openDepth: number;
}) {
  const [open, setOpen] = useState(depth < openDepth);
  const [shown, setShown] = useState(CHILD_PAGE);
  const key =
    name === undefined ? null : (
      <span className="text-fg-muted">{typeof name === 'number' ? name : JSON.stringify(name)}: </span>
    );
  if (value === null || typeof value !== 'object') {
    return (
      <div className="pl-4">
        {key}
        <Primitive v={value} />
      </div>
    );
  }
  const isArray = Array.isArray(value);
  const entries: [string | number, unknown][] = isArray
    ? (value as unknown[]).map((x, i) => [i, x])
    : Object.entries(value as Record<string, unknown>);
  const [o, c] = isArray ? ['[', ']'] : ['{', '}'];
  return (
    <div className={depth ? 'pl-4' : ''}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="inline-flex items-center gap-1 rounded-sm text-left hover:bg-surface-hover"
      >
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={10} />
        {key}
        <span className="text-fg-subtle">
          {o}
          {open ? '' : ` ${entries.length} ${isArray ? 'items' : 'keys'} ${c}`}
        </span>
      </button>
      {open && (
        <div role="group">
          {entries.slice(0, shown).map(([k, v]) => (
            <JsonNode key={k} name={k} value={v} depth={depth + 1} openDepth={openDepth} />
          ))}
          {entries.length > shown && (
            <button
              type="button"
              className="ml-4 text-caption text-fg-muted underline"
              onClick={() => setShown(shown + CHILD_PAGE)}
            >
              Show {Math.min(CHILD_PAGE, entries.length - shown)} more of {entries.length - shown} remaining
            </button>
          )}
          <div className="text-fg-subtle">{c}</div>
        </div>
      )}
    </div>
  );
}
