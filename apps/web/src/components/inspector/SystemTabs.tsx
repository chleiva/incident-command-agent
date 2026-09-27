/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** System inspector: one tab per mocked system (`SYSTEM_ENTITIES`), live tables with change highlights. */
import {
  ENTITY_KEY,
  SYSTEM_ENTITIES,
  type RunProjection,
  type StateSystemName,
  type SystemState,
} from '@ica/schema/browser';
import * as Tabs from '@radix-ui/react-tabs';
import { useState } from 'react';
import { UNKNOWN } from '@ica/schema/browser';
import { StateFrame, cx, type LoadStatus } from '../ui/primitives';
import { EntityTable } from './EntityTable';

/**
 * Maintenance rows always show their record fields; a missing one reads "Unknown" (task 06 §1.6), never a
 * default such as passed, OK or serviceable.
 */
export function maintenanceRows(entity: string, rows: Record<string, unknown>[]): Record<string, unknown>[] {
  if (entity === 'aircraft')
    return rows.map(({ maintenance, ...r }) => {
      const m = (maintenance ?? {}) as {
        lastCheckType?: string;
        lastCheckDate?: string;
        defectHistory?: string[];
      };
      return {
        ...r,
        lastCheck:
          m.lastCheckType || m.lastCheckDate
            ? [m.lastCheckType, m.lastCheckDate].filter(Boolean).join(' ')
            : undefined,
        defectHistory: m.defectHistory?.length ? m.defectHistory.join('; ') : undefined,
      };
    });
  if (entity === 'defects') return rows.map((r) => ({ ata: undefined, melItem: undefined, ...r }));
  if (entity === 'workOrders') return rows.map((r) => ({ status: undefined, ...r }));
  return rows;
}

const SYSTEM_LABEL: Record<StateSystemName, string> = {
  mne: 'M&E',
  occ: 'OCC',
  crew: 'Crew',
  pss: 'PSS',
  airport: 'Airport',
  handler: 'Handler',
  engineers: 'Engineers',
  record: 'Record',
};

export function SystemTabs({
  systems,
  recent,
  lastMutation,
  status = 'ready',
  error,
  defaultSystem = 'mne',
}: {
  systems: SystemState;
  /** `${system}/${entity}/${id}` → seq. */
  recent: Map<string, number>;
  lastMutation: RunProjection['lastMutation'];
  status?: LoadStatus;
  error?: string | null;
  defaultSystem?: StateSystemName;
}) {
  const [tab, setTab] = useState<StateSystemName>(defaultSystem);
  const names = Object.keys(SYSTEM_ENTITIES) as StateSystemName[];
  const loose = systems as unknown as Record<string, Record<string, Record<string, Record<string, unknown>>>>;
  const total = names.reduce(
    (n, s) => n + Object.values(loose[s] ?? {}).reduce((m, e) => m + Object.keys(e).length, 0),
    0,
  );

  return (
    <StateFrame
      status={status}
      error={error}
      empty={total === 0}
      emptyText="Systems are seeded when the run starts."
    >
      <Tabs.Root
        value={tab}
        onValueChange={(v) => setTab(v as StateSystemName)}
        className="flex h-full min-h-0 flex-col"
      >
        <Tabs.List
          aria-label="Mocked systems"
          className="flex shrink-0 gap-0.5 overflow-x-auto border-b border-border"
        >
          {names.map((s) => {
            const touched = [...recent.keys()].some((k) => k.startsWith(`${s}/`));
            return (
              <Tabs.Trigger
                key={s}
                value={s}
                className={cx(
                  'relative h-7 whitespace-nowrap px-2 text-caption text-fg-muted hover:text-fg',
                  'data-[state=active]:text-fg data-[state=active]:after:absolute data-[state=active]:after:inset-x-1 data-[state=active]:after:-bottom-px data-[state=active]:after:h-0.5 data-[state=active]:after:bg-fg',
                )}
              >
                {SYSTEM_LABEL[s]}
                {touched && (
                  <span
                    className="ml-1 inline-block h-1 w-1 rounded-full bg-ai align-middle"
                    aria-label="recently changed"
                  />
                )}
              </Tabs.Trigger>
            );
          })}
        </Tabs.List>
        {names.map((s) => (
          <Tabs.Content key={s} value={s} className="zone-scroll min-h-0 flex-1 pt-2 outline-none">
            {SYSTEM_ENTITIES[s].map((entity) => {
              const map = loose[s]?.[entity] ?? {};
              const keyField = (ENTITY_KEY as Record<string, Record<string, string>>)[s]![entity]!;
              const recentForEntity = new Map(
                [...recent.entries()]
                  .filter(([k]) => k.startsWith(`${s}/${entity}/`))
                  .map(([k, v]) => [k.slice(`${s}/${entity}/`.length), v]),
              );
              const latestId =
                lastMutation && lastMutation.system === s && lastMutation.entity === entity
                  ? lastMutation.id
                  : null;
              return (
                <EntityTable
                  key={entity}
                  title={entity}
                  rows={s === 'mne' ? maintenanceRows(entity, Object.values(map)) : Object.values(map)}
                  missing={s === 'mne' ? UNKNOWN : '—'}
                  keyField={keyField}
                  recent={recentForEntity}
                  latestId={latestId}
                />
              );
            })}
          </Tabs.Content>
        ))}
      </Tabs.Root>
    </StateFrame>
  );
}
