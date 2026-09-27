/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Home: Accent Air's live network. The fictional day schedule is replayed against the real UTC wall clock and
 * computed entirely in the browser (zero backend cost while idle). Pick a flight on the map or in the list to open
 * its panel; "Report incident" starts a coordinated response from the flight's context.
 */
import { findFlight } from '@ica/network';
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useRunActions } from '../app/actions';
import { AppShell } from '../app/AppShell';
import { useServices } from '../app/services';
import { FlightList } from '../components/network/FlightList';
import { FlightPanel } from '../components/network/FlightPanel';
import { LiveNetworkMap } from '../components/network/LiveNetworkMap';
import { NetworkClockBar } from '../components/network/NetworkClockBar';
import { ReportIncidentDialog } from '../components/network/ReportIncidentDialog';
import { useNetworkClock, useNetworkSchedule, useNetworkTime } from '../lib/networkClock';

const LIST_W = 360;
const PANEL_W = 420;

export default function Home() {
  const t = useNetworkTime(1000);
  const schedule = useNetworkSchedule(t);
  const [params, setParams] = useSearchParams();
  const selected = params.get('flight');
  const [hovered, setHovered] = useState<string | null>(null);
  const flight = selected ? findFlight(schedule, selected) : undefined;
  const [reporting, setReporting] = useState<number | null>(null);
  const seed = useNetworkClock((s) => s.seed);
  const { mode } = useServices();
  const actions = useRunActions();

  const select = useCallback(
    (f: string | null) => {
      const next = new URLSearchParams(params);
      if (f) next.set('flight', f);
      else next.delete('flight');
      setParams(next, { replace: true });
    },
    [params, setParams],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && selected && !document.querySelector('[role="dialog"]')) select(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected, select]);

  return (
    <AppShell>
      <div className="relative h-[calc(100vh-3rem)] min-h-[520px] overflow-hidden bg-bg">
        <h1 className="sr-only">Live network</h1>
        <LiveNetworkMap
          schedule={schedule}
          selected={selected}
          hovered={hovered}
          onSelect={select}
          onHover={setHovered}
          insetLeft={LIST_W + 16}
          insetRight={flight ? PANEL_W + 16 : 0}
        />
        <div className="absolute bottom-3 left-3 top-3 z-10 hidden md:block" style={{ width: LIST_W }}>
          <FlightList schedule={schedule} t={t} selected={selected} onSelect={select} onHover={setHovered} />
        </div>
        <div
          className="pointer-events-none absolute top-3 z-10 flex flex-col items-center gap-1"
          style={{ left: LIST_W + 24, right: flight ? PANEL_W + 24 : 12 }}
        >
          <div className="pointer-events-auto">
            <NetworkClockBar t={t} />
          </div>
          <p className="max-w-[70ch] text-center text-micro text-fg-subtle">
            {schedule.carrier.name} · fictional day schedule on the real UTC clock, computed in your browser.
            Airports are real; flights, aircraft and people are fictional.
          </p>
        </div>
        {flight && (
          <div
            className="absolute bottom-3 right-3 top-3 z-20"
            style={{ width: PANEL_W, maxWidth: 'calc(100% - 24px)' }}
          >
            <FlightPanel
              schedule={schedule}
              flight={flight}
              t={t}
              onClose={() => select(null)}
              onReport={() => setReporting(t)}
            />
          </div>
        )}
        {flight && (
          <ReportIncidentDialog
            open={reporting !== null}
            onOpenChange={(o) => !o && setReporting(null)}
            schedule={schedule}
            flight={flight}
            t={reporting ?? t}
            mode={mode === 'mock' ? 'mock' : 'live'}
            onStart={(r) =>
              actions.startFromFlight(
                {
                  flightContext: {
                    seed,
                    date: schedule.date,
                    flightId: flight.flight,
                    at: new Date(reporting ?? t).toISOString(),
                  },
                  incidentType: r.incidentType,
                  ...(r.text ? { text: r.text } : {}),
                },
                { withBaseline: r.withBaseline, speed: r.speed, presenterPace: r.presenterPace },
              )
            }
          />
        )}
      </div>
    </AppShell>
  );
}
