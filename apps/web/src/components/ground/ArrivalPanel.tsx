/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Arrival station (task 07): for an aircraft in the air, what meets it where the commander is landing — the
 * commander's decision (a human decision, relayed to the ground), the ETA countdown, fire and rescue / medical /
 * police requests, handling and the engineers heading there.
 */
import type {
  AirborneFlight,
  CommanderLogEntry,
  Engineer,
  HandlerTask,
  ResourceRequest,
} from '@ica/schema/browser';
import { DECISION_LABEL, SQUAWK_LABEL, airborneAt } from '../../lib/airborne';
import { formatDuration } from '../../lib/format';
import { Term } from '../../glossary/Term';
import { Icon } from '../ui/Icon';
import { Badge, cx } from '../ui/primitives';

const SERVICE_LABEL: Record<string, string> = {
  fire_service: 'Fire and rescue standby',
  medical: 'Medical team',
  police: 'Police',
};

export function ArrivalPanel({
  airborne,
  commanderLog,
  resources,
  tasks,
  engineers,
  minute,
}: {
  airborne: AirborneFlight;
  commanderLog: CommanderLogEntry[];
  resources: ResourceRequest[];
  tasks: HandlerTask[];
  engineers: Engineer[];
  minute: number;
}) {
  const v = airborneAt(airborne, minute);
  const at = v.destination;
  const services = resources.filter((r) => r.station === at && SERVICE_LABEL[r.kind]);
  const handling = tasks.filter((t) => t.station === at);
  const meeting = engineers.filter((e) => e.station === at || e.destination === at);
  const decision = commanderLog.filter((l) => l.flight === airborne.flight).at(-1);
  return (
    <section
      aria-label="Arrival station"
      data-testid="arrival-panel"
      className="flex flex-col gap-2 rounded-md border border-border p-2"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Icon name="plane" size={14} />
        <span className="num text-body font-medium text-fg">{airborne.flight}</span>
        <span className="text-caption text-fg-muted">
          {airborne.from} → <span className="num text-fg">{at}</span>
          {v.diverted ? ` (planned ${airborne.plannedDestination})` : ''}
        </span>
        {v.squawk !== 'normal' && (
          <Badge tone={v.squawk === 'mayday' ? 'critical' : 'warning'}>
            <Term term="PAN / MAYDAY">{SQUAWK_LABEL[v.squawk]}</Term>
          </Badge>
        )}
        <span
          className={cx('num ml-auto text-title', v.phase === 'landed' ? 'text-good' : 'text-fg')}
          data-testid="arrival-eta"
          aria-live="off"
        >
          {v.phase === 'landed' ? 'Landed' : `Lands in ${formatDuration(v.minutesToLanding)}`}
        </span>
      </div>
      <p className="text-caption text-fg-muted" data-testid="commander-line">
        {decision ? (
          <>
            <span className="text-fg">Commander:</span> {DECISION_LABEL[decision.decision]}
            {decision.airport ? ` to ${decision.airport}` : ''}
            {decision.overweightLanding ? (
              <>
                , <Term term="Overweight landing">overweight landing</Term> expected
              </>
            ) : null}{' '}
            (human decision, relayed to the ground).
          </>
        ) : (
          'The commander flies and decides the aircraft; the ground prepares options and the arrival.'
        )}
      </p>
      <ul className="grid grid-cols-1 gap-1 text-caption sm:grid-cols-2">
        {services.length === 0 && <li className="text-fg-subtle">No arrival services requested yet.</li>}
        {services.map((r) => (
          <li
            key={r.id}
            className="flex items-center justify-between gap-2 rounded-sm bg-surface-hover px-2 py-1"
          >
            <span className="text-fg">{SERVICE_LABEL[r.kind]}</span>
            <span className="num text-fg-muted">
              {r.status} · ETA m{Math.round(r.etaMinute)}
            </span>
          </li>
        ))}
        {handling.map((t) => (
          <li
            key={t.id}
            className="flex items-center justify-between gap-2 rounded-sm bg-surface-hover px-2 py-1"
          >
            <span className="truncate text-fg">{t.note}</span>
            <span className="num text-fg-muted">{t.status}</span>
          </li>
        ))}
        {meeting.map((e) => (
          <li
            key={e.id}
            className="flex items-center justify-between gap-2 rounded-sm bg-surface-hover px-2 py-1"
          >
            <span className="text-fg">
              Engineer {e.name} ({e.licence})
            </span>
            <span className="num text-fg-muted">
              {e.status}
              {e.etaMinute !== undefined ? ` · ETA m${Math.round(e.etaMinute)}` : ''}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
