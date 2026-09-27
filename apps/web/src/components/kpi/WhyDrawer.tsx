/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** "Why this number": the formula, the inputs, and the events that moved it (links move the scrubber). */
import type { KpiSnapshot, RunEvent } from '@ica/schema/browser';
import { describeEvent } from '../../lib/describe';
import { Drawer } from '../ui/Drawer';
import { Icon } from '../ui/Icon';
import { tileModels, type KpiTileKey } from './kpiModel';

function fmtInput(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'number') return Number.isInteger(v) ? v.toLocaleString('en-GB') : v.toFixed(1);
  return String(v);
}

const humanKey = (k: string) =>
  k.replace(/([a-z])([A-Z0-9])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());

export function WhyDrawer({
  tile,
  kpis,
  events,
  onClose,
  onJump,
  startTime,
}: {
  tile: KpiTileKey | null;
  kpis: KpiSnapshot | null;
  events: readonly RunEvent[];
  onClose: () => void;
  onJump: (seq: number) => void;
  startTime?: string | null;
}) {
  const model = tile && kpis ? tileModels(kpis, null).find((m) => m.key === tile) : undefined;
  const why = model && kpis ? model.why(kpis) : null;
  const bySeq = new Map(events.map((e) => [e.seq, e]));
  return (
    <Drawer
      open={!!tile}
      onOpenChange={(o) => !o && onClose()}
      title={model ? `Why this number: ${model.label}` : 'Why this number'}
      description={model ? `${model.display} at sim minute ${kpis?.simMinute.toFixed(1)}` : undefined}
    >
      {!why && (
        <p role="alert" className="text-body text-fg-muted">
          This number isn’t available yet: no KPI snapshot has been received for this moment.
        </p>
      )}
      {why && (
        <div className="flex flex-col gap-5">
          <section>
            <h3 className="caps mb-2 text-fg-muted">Formula</h3>
            <p className="rounded-md bg-surface-sunken px-3 py-2 font-mono text-caption text-fg">
              {why.formula}
            </p>
          </section>
          {why.extra && (
            <section>
              <h3 className="caps mb-2 text-fg-muted">Breakdown</h3>
              <dl className="flex flex-col gap-1">
                {why.extra.map(([k, v]) => (
                  <div key={k} className="flex justify-between gap-4 text-body">
                    <dt className="text-fg-muted">{k}</dt>
                    <dd className="num text-right text-fg">{v}</dd>
                  </div>
                ))}
              </dl>
            </section>
          )}
          <section>
            <h3 className="caps mb-2 text-fg-muted">Inputs</h3>
            <table className="w-full text-body">
              <tbody>
                {Object.entries(why.inputs).map(([k, v]) => (
                  <tr key={k} className="border-b border-border last:border-0">
                    <th scope="row" className="py-1 pr-4 text-left font-normal text-fg-muted">
                      {humanKey(k)}
                    </th>
                    <td className="num py-1 text-right text-fg">{fmtInput(v)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <section>
            <h3 className="caps mb-2 text-fg-muted">Events that moved it</h3>
            {why.seqs.length === 0 ? (
              <p className="text-body text-fg-subtle">No events have moved this number yet.</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {why.seqs.map((seq) => {
                  const e = bySeq.get(seq);
                  return (
                    <li key={seq}>
                      <button
                        type="button"
                        data-testid={`why-seq-${seq}`}
                        onClick={() => onJump(seq)}
                        className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-body hover:bg-surface-hover"
                      >
                        <span className="num w-12 shrink-0 text-caption text-fg-subtle">#{seq}</span>
                        <span className="min-w-0 flex-1 truncate text-fg">
                          {e ? describeEvent(e) : 'Event not loaded'}
                        </span>
                        {e && startTime !== undefined && (
                          <span className="num text-caption text-fg-subtle">m{e.simMinute.toFixed(1)}</span>
                        )}
                        <Icon name="chevronRight" size={12} className="text-fg-subtle" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            <p className="mt-2 text-caption text-fg-subtle">
              Selecting an event moves the timeline to that moment.
            </p>
          </section>
        </div>
      )}
    </Drawer>
  );
}
