/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Storybook support: fixture-driven data (the mock recordings folded with the shared reducer) and a frame that
 * mimics a cockpit zone. Every component has Empty / Loading / Live / Error stories.
 */
import { foldEvents } from '@ica/schema/browser';
import type { ReactElement, ReactNode } from 'react';
import { StateFrame } from '../components/ui/primitives';
import { Zone } from '../components/ui/Zone';
import {
  agentFeed,
  activeRoles,
  eventMarkers,
  kpiAtMinute,
  kpiSeries,
  recentMutations,
  travelStarts,
} from '../lib/derive';
import { S01, S04, pendingApproval, viewAt } from '../test/fixtureViews';

export { S01, S04, pendingApproval, viewAt };

export const MID = viewAt(S01.agent, 31);
export const EARLY = viewAt(S01.agent, 13);
export const END = { events: S01.agent, view: foldEvents(S01.agent) };
export const BASE_END = foldEvents(S01.baseline);
export const SERIES_MID = kpiSeries(MID.events);
export const kpiSeriesEarly = kpiSeries(EARLY.events);
export const BASE_SERIES = kpiSeries(S01.baseline);
export const GHOST_MID = kpiAtMinute(BASE_SERIES, 31);
export const FEED_MID = agentFeed(MID.events);
export const ROLES_MID = activeRoles(MID.view);
export const MARKERS = eventMarkers(S01.agent);
export const BASE_MARKERS = eventMarkers(S01.baseline).filter((m) => m.kind === 'baseline');
export const RECENT_MID = recentMutations(MID.events);
export const STARTS_EARLY = travelStarts(EARLY.events);
export const clock = (m: number) => {
  const d = new Date(Date.parse(S01.scenario.startSimTime) + m * 60_000);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
};

/** A zone-like frame so components are shown at realistic sizes. */
export function Frame({
  children,
  width = 460,
  height,
  title = 'Zone',
}: {
  children: ReactNode;
  width?: number | string;
  height?: number;
  title?: string;
}) {
  return (
    <div style={{ width, height }} className="flex flex-col">
      <Zone id={`story-${title}`} title={title} className="flex-1" bodyClassName="p-3" expandable={false}>
        {children}
      </Zone>
    </div>
  );
}

export const noop = () => {};

type Render = { name?: string; render: () => ReactElement };

/**
 * The four states for a leaf component: Live and Empty render the component; Loading and Error show how its
 * zone presents it (the design-system StateFrame skeleton and error panel).
 */
export function fourStates(
  live: () => ReactNode,
  empty: () => ReactNode,
  wrap: (n: ReactNode) => ReactNode = (n) => n,
): { Empty: Render; Loading: Render; Live: Render; ErrorState: Render } {
  return {
    Empty: { render: () => <>{wrap(empty())}</> },
    Loading: {
      render: () => (
        <>
          {wrap(
            <StateFrame status="loading">
              <span />
            </StateFrame>,
          )}
        </>
      ),
    },
    Live: { render: () => <>{wrap(live())}</> },
    ErrorState: {
      name: 'Error',
      render: () => (
        <>
          {wrap(
            <StateFrame status="error" error="The API returned 503; retrying.">
              <span />
            </StateFrame>,
          )}
        </>
      ),
    },
  };
}
