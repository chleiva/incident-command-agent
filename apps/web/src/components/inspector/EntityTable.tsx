/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** A live table of one entity map; rows touched by the latest mutations are highlighted. */
import type { Actor } from '@ica/schema/browser';
import { actorLabel } from '../../lib/format';
import { cx } from '../ui/primitives';

type Row = Record<string, unknown>;

const PRIORITY = [
  'status',
  'kind',
  'tail',
  'flight',
  'name',
  'station',
  'decision',
  'delayMin',
  'etaMinute',
  'count',
];
const HIDDEN = new Set(['aiDrafted', 'forHumanReporter', 'contents']);

function isActor(v: unknown): v is Actor {
  return (
    !!v &&
    typeof v === 'object' &&
    'kind' in (v as object) &&
    ['agent', 'human', 'policy', 'world'].includes(String((v as { kind: unknown }).kind))
  );
}

export function formatCell(v: unknown, missing = '—'): string {
  if (v === null || v === undefined) return missing;
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(1);
  if (typeof v === 'string') {
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) return `${v.slice(11, 16)}Z`;
    return v;
  }
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'object' ? '…' : String(x))).join(', ');
  if (isActor(v)) return actorLabel(v);
  return JSON.stringify(v);
}

export function columnsFor(rows: Row[], keyField: string, max = 7): string[] {
  const keys = new Set<string>();
  rows.forEach((r) => Object.keys(r).forEach((k) => !HIDDEN.has(k) && keys.add(k)));
  keys.delete(keyField);
  const rest = [...keys].sort((a, b) => {
    const pa = PRIORITY.indexOf(a);
    const pb = PRIORITY.indexOf(b);
    return (pa < 0 ? 99 : pa) - (pb < 0 ? 99 : pb);
  });
  return [keyField, ...rest].slice(0, max);
}

export function EntityTable({
  title,
  rows,
  keyField,
  recent,
  latestId,
  missing = '—',
}: {
  /** Shown for a missing field (maintenance records: "Unknown", never a default). */
  missing?: string;
  title: string;
  rows: Row[];
  keyField: string;
  /** id → seq of recent mutations. */
  recent?: Map<string, number>;
  latestId?: string | null;
}) {
  const cols = columnsFor(rows, keyField);
  return (
    <section aria-label={`${title} (${rows.length})`}>
      <h3 className="caps mb-1 flex items-center gap-2 text-fg-muted">
        {title} <span className="num text-fg-subtle">{rows.length}</span>
      </h3>
      {rows.length === 0 ? (
        <p className="mb-2 text-caption text-fg-subtle">Empty</p>
      ) : (
        <div tabIndex={0} role="region" aria-label={`${title} table`} className="mb-3 overflow-x-auto">
          <table className="w-full text-caption">
            <thead>
              <tr className="text-left text-fg-subtle">
                {cols.map((c) => (
                  <th
                    key={c}
                    scope="col"
                    className="whitespace-nowrap border-b border-border py-1 pr-3 font-medium"
                  >
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const id = String(r[keyField]);
                const seq = recent?.get(id);
                const latest = latestId === id;
                return (
                  <tr
                    key={`${id}-${seq ?? 0}`}
                    data-row={id}
                    data-changed={seq !== undefined || undefined}
                    className={cx(
                      'border-b border-border last:border-0',
                      seq !== undefined && 'animate-flash',
                      latest && 'bg-ai-bg',
                    )}
                  >
                    {cols.map((c, i) => (
                      <td
                        key={c}
                        className={cx(
                          'max-w-64 truncate py-1 pr-3',
                          i === 0 ? 'font-mono text-fg' : 'text-fg-muted',
                        )}
                        title={formatCell(r[c], missing)}
                      >
                        {i === 0 && latest && (
                          <span className="sr-only">Changed by the latest mutation: </span>
                        )}
                        {formatCell(r[c], missing)}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
